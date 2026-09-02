// The top-up routine.
//
// Problem: the Buffer Free plan holds only a small number of scheduled posts at once
// (10 at the time of writing). A 30 day month on two channels needs 60 scheduled posts.
// They do not fit.
//
// Answer: keep the queue full instead of filling it once. Every run this script:
//   1. reads the live channel list (ids change when a channel is reconnected),
//   2. counts how many posts Buffer is holding,
//   3. adds the next posts that are due, oldest first, until Buffer says stop,
//   4. writes state.json so the next run knows what already exists.
//
// It never creates the same post twice, and it never posts anything early.
// Buffer publishes at the time in posts.json. This script only fills the queue.
//
// Usage:  BUFFER_TOKEN=... node scripts/topup.mjs [--dry-run]
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getChannels, listPosts, createPost, BufferError } from './buffer.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry-run')
const TOKEN = process.env.BUFFER_TOKEN
if (!TOKEN) fail('BUFFER_TOKEN is not set')

// Buffer holds this many scheduled posts on the Free plan. If Buffer says the
// limit is reached before we get here, we stop on its answer, not on this number.
const QUEUE_TARGET = Number(process.env.QUEUE_TARGET || 10)
// Never create a post that is due sooner than this. Buffer needs time to fetch the image.
const LEAD_MINUTES = Number(process.env.LEAD_MINUTES || 30)
// Statuses that occupy a slot in Buffer's queue.
const HOLDING = ['scheduled', 'needs_approval', 'sending', 'draft']

const log = []
const alerts = []
const say = (m) => { log.push(m); console.log(m) }
// An alert makes the GitHub Action fail. A failed Action emails the repo owner.
// That is the only way anybody finds out that a post did not go out.
const alert = (m) => { alerts.push(m); console.error(`ALERT: ${m}`) }
function fail(m) { console.error(`FAIL: ${m}`); process.exit(1) }

const plan = JSON.parse(await readFile(join(ROOT, 'posts.json'), 'utf8'))
// A missing state file is normal on the first run. An unreadable one is not, and it must
// not pass quietly. Either way the run is safe: the slot check below rebuilds what was lost.
let state = { created: {}, failed: {}, runs: [] }
let stateWasBroken = null
try { state = JSON.parse(await readFile(join(ROOT, 'state.json'), 'utf8')) }
catch (e) { if (e.code !== 'ENOENT') stateWasBroken = e.message }
state.created ||= {}
state.failed ||= {}
state.runs ||= []

if (stateWasBroken) alert(`state.json could not be read (${stateWasBroken}). Rebuilding it from Buffer.`)

// The targets are pinned in posts.json by the platform's own id, not by position.
// "The first organization" and "the first Instagram channel" would silently move
// if a second one were ever connected.
const orgId = plan.buffer.organizationId
const wantedIds = plan.buffer.channels
const wanted = Object.keys(wantedIds)

const channels = await getChannels(TOKEN, orgId)
say(`organization ${orgId}, ${channels.length} channels`)

const byService = {}
for (const service of wanted) {
  const want = String(wantedIds[service])
  const hits = channels.filter((c) => c.service === service && String(c.serviceId) === want)
  if (hits.length !== 1) fail(`expected exactly 1 ${service} channel with serviceId ${want}, found ${hits.length}`)
  if (hits[0].isDisconnected) fail(`${service} channel ${hits[0].name} is disconnected`)
  byService[service] = hits[0]
}
for (const s of wanted) say(`${s}: ${byService[s].name} (${byService[s].id}, type ${byService[s].type})`)

// An Instagram channel of type "profile" cannot auto publish. It can only send a
// phone reminder. Stop loudly rather than silently building a month of reminders.
if (byService.instagram.type === 'profile') {
  fail('Instagram is connected as a personal profile. Reconnect it as a Business account, or Buffer cannot post on its own.')
}

const held = await listPosts(TOKEN, orgId, HOLDING)
const errored = await listPosts(TOKEN, orgId, ['error'])
const sent = await listPosts(TOKEN, orgId, ['sent'])
const all = [...held, ...errored, ...sent]
const liveIds = new Set(all.map((p) => p.id))
// A second, stronger guard against a duplicate. Every post in the plan has a unique
// channel and time. If Buffer already holds a post at that channel and time, it is ours,
// even if state.json was lost or a run died before it could be written.
const liveSlots = new Set(all.map((p) => `${p.channelId}|${Date.parse(p.dueAt)}`))
say(`buffer now holds ${held.length}, sent ${sent.length}, errored ${errored.length}`)

for (const p of errored) {
  if (Object.values(state.created).includes(p.id)) alert(`post ${p.id} due ${p.dueAt} failed to publish. Open Buffer and look.`)
}

// Drop remembered ids that Buffer no longer knows about, so a post deleted by hand is rebuilt.
for (const [key, id] of Object.entries(state.created)) {
  if (!liveIds.has(id)) { say(`forgot ${key}, buffer no longer has post ${id}`); delete state.created[key] }
}

const before = JSON.stringify(state.created) + JSON.stringify(state.failed)
const now = Date.now()
const earliest = now + LEAD_MINUTES * 60000
const jobs = []
for (const post of plan.posts) {
  for (const service of wanted) {
    const key = `${post.day}:${service}`
    if (state.created[key]) continue
    const dueAt = post.schedule[service]
    const slot = `${byService[service].id}|${Date.parse(dueAt)}`
    if (liveSlots.has(slot)) {
      const found = all.find((p) => `${p.channelId}|${Date.parse(p.dueAt)}` === slot)
      state.created[key] = found.id
      say(`recovered ${key}, buffer already has ${found.id} (${found.status}) at that time`)
      continue
    }
    if (Date.parse(dueAt) < earliest) {
      if (!state.failed[key]) alert(`SKIP ${key} due ${dueAt} passed without being scheduled`)
      state.failed[key] = { reason: 'past due', dueAt, seenAt: new Date().toISOString() }
      continue
    }
    jobs.push({ key, post, service, dueAt })
  }
}
jobs.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))

let capacity = Math.max(0, QUEUE_TARGET - held.length)
say(`${jobs.length} posts still to schedule, room for ${capacity} now`)

let added = 0
for (const job of jobs) {
  if (capacity <= 0) break
  const input = buildInput(job, byService)
  if (DRY) { say(`DRY would add ${job.key} due ${job.dueAt}`); capacity--; added++; continue }
  let r
  try { r = await createPost(TOKEN, input) }
  catch (e) { if (e instanceof BufferError) { say(`STOP ${job.key}: ${e.message}`); break } throw e }
  if (r.ok) {
    state.created[job.key] = r.post.id
    delete state.failed[job.key]
    // Save after every single create. If this process dies now, the next run still knows.
    if (!DRY) await saveState()
    say(`added ${job.key} due ${job.dueAt} -> ${r.post.id} (${r.post.status})`)
    capacity--
    added++
  } else {
    const m = r.message
    state.failed[job.key] = { reason: m, seenAt: new Date().toISOString() }
    if (/limit|upgrade|plan/i.test(m)) { say(`STOP at ${job.key}: buffer says ${m}`); break }
    alert(`REJECTED ${job.key}: ${m}`)
  }
}

const remaining = plan.posts.length * wanted.length - Object.keys(state.created).length
// Only record a run that changed something. A log line every 6 hours for 34 days would be
// 136 pointless commits, and every commit is another chance for a push to conflict.
const changed = JSON.stringify(state.created) + JSON.stringify(state.failed) !== before
if (changed) {
  state.runs.unshift({ at: new Date().toISOString(), dryRun: DRY, held: held.length, added, remaining })
  state.runs = state.runs.slice(0, 60)
  if (!DRY) await saveState()
} else {
  say('nothing changed, state.json left alone')
}
say(`done. added ${added}. ${Object.keys(state.created).length} scheduled so far, ${remaining} left to go.`)

if (alerts.length) {
  console.error(`\n${alerts.length} thing(s) need a human:`)
  for (const a of alerts) console.error(`  - ${a}`)
  process.exit(1)
}

async function saveState() {
  state.updatedAt = new Date().toISOString()
  await writeFile(join(ROOT, 'state.json'), JSON.stringify(state, null, 2) + '\n')
}

function buildInput({ post, service, dueAt }, chans) {
  const assets = post.assets.map((a) => ({ image: { url: a.url, metadata: { altText: a.altText } } }))
  const metadata =
    service === 'instagram'
      // Instagram has no 'carousel' post type in this API. Buffer rejects it.
      // Several pictures on a post of type 'post' IS the carousel. Verified 2 Sep 2026.
      ? { instagram: { type: 'post', shouldShareToFeed: true, isAiGenerated: !!post.aiAssisted } }
      : { facebook: { type: 'post' } }
  return {
    channelId: chans[service].id,
    text: post.text,
    assets,
    metadata,
    dueAt,
    mode: 'customScheduled',
    schedulingType: 'automatic',
    needsApproval: false,
    aiAssisted: !!post.aiAssisted,
    source: 'aluvalue-social-queue',
  }
}
