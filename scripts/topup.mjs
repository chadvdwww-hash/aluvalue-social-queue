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
import { getOrganizationId, getChannels, listPosts, createPost, BufferError } from './buffer.mjs'

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
const say = (m) => { log.push(m); console.log(m) }
function fail(m) { console.error(`FAIL: ${m}`); process.exit(1) }

const plan = JSON.parse(await readFile(join(ROOT, 'posts.json'), 'utf8'))
let state
try { state = JSON.parse(await readFile(join(ROOT, 'state.json'), 'utf8')) }
catch { state = { created: {}, failed: {}, runs: [] } }
state.created ||= {}
state.failed ||= {}
state.runs ||= []

const orgId = await getOrganizationId(TOKEN)
const channels = await getChannels(TOKEN, orgId)
say(`organization ${orgId}, ${channels.length} channels`)

const byService = {}
for (const c of channels) {
  if (c.isDisconnected) { say(`WARN channel ${c.name} (${c.service}) is disconnected`); continue }
  byService[c.service] ||= c
}
const wanted = ['instagram', 'facebook']
const missing = wanted.filter((s) => !byService[s])
if (missing.length) fail(`no connected channel for: ${missing.join(', ')}`)
for (const s of wanted) say(`${s}: ${byService[s].name} (${byService[s].id}, type ${byService[s].type})`)

// An Instagram channel of type "profile" cannot auto publish. It can only send a
// phone reminder. Stop loudly rather than silently building a month of reminders.
if (byService.instagram.type === 'profile') {
  fail('Instagram is connected as a personal profile. Reconnect it as a Business account, or Buffer cannot post on its own.')
}

const held = await listPosts(TOKEN, orgId, HOLDING)
const errored = await listPosts(TOKEN, orgId, ['error'])
const sent = await listPosts(TOKEN, orgId, ['sent'])
const liveIds = new Set([...held, ...errored, ...sent].map((p) => p.id))
say(`buffer now holds ${held.length}, sent ${sent.length}, errored ${errored.length}`)

for (const p of errored) {
  if (Object.values(state.created).includes(p.id)) say(`ERROR post ${p.id} due ${p.dueAt} failed to publish. Check Buffer.`)
}

// Drop remembered ids that Buffer no longer knows about, so a post deleted by hand is rebuilt.
for (const [key, id] of Object.entries(state.created)) {
  if (!liveIds.has(id)) { say(`forgot ${key}, buffer no longer has post ${id}`); delete state.created[key] }
}

const now = Date.now()
const earliest = now + LEAD_MINUTES * 60000
const jobs = []
for (const post of plan.posts) {
  for (const service of wanted) {
    const key = `${post.day}:${service}`
    if (state.created[key]) continue
    const dueAt = post.schedule[service]
    if (Date.parse(dueAt) < earliest) {
      if (!state.failed[key]) say(`SKIP ${key} due ${dueAt} is in the past or too soon`)
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
    say(`added ${job.key} due ${job.dueAt} -> ${r.post.id} (${r.post.status})`)
    capacity--
    added++
  } else {
    const m = r.message
    state.failed[job.key] = { reason: m, seenAt: new Date().toISOString() }
    if (/limit|upgrade|plan/i.test(m)) { say(`STOP at ${job.key}: buffer says ${m}`); break }
    say(`REJECTED ${job.key}: ${m}`)
  }
}

const remaining = plan.posts.length * wanted.length - Object.keys(state.created).length
state.runs.unshift({ at: new Date().toISOString(), dryRun: DRY, held: held.length, added, remaining })
state.runs = state.runs.slice(0, 60)
state.updatedAt = new Date().toISOString()
if (!DRY) await writeFile(join(ROOT, 'state.json'), JSON.stringify(state, null, 2) + '\n')
say(`done. added ${added}. ${Object.keys(state.created).length} scheduled so far, ${remaining} left to go.`)

function buildInput({ post, service, dueAt }, chans) {
  const assets = post.assets.map((a) => ({ image: { url: a.url, metadata: { altText: a.altText } } }))
  const metadata =
    service === 'instagram'
      ? { instagram: { type: post.postType === 'carousel' ? 'carousel' : 'post', shouldShareToFeed: true, isAiGenerated: !!post.aiAssisted } }
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
