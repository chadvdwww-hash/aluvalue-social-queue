// Buffer does not accept an upload. It fetches the picture from a public link at
// publish time. If a link is broken then, the post fails and nobody sees it.
// So check every link before we schedule anything.
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plan = JSON.parse(await readFile(join(ROOT, 'posts.json'), 'utf8'))
const urls = [...new Set(plan.posts.flatMap((p) => p.assets.map((a) => a.url)))]
let bad = 0
for (const url of urls) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  const type = r.headers.get('content-type') || ''
  const ok = r.ok && type.startsWith('image/')
  if (!ok) { bad++; console.error(`BAD ${r.status} ${type} ${url}`) }
}
console.log(`${urls.length - bad}/${urls.length} images reachable`)
process.exit(bad ? 1 : 0)
