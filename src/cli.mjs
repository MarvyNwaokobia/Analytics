import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { openDb } from './db.mjs'
import { makeClient, indexProject, checkVerified } from './indexer.mjs'
import { buildMetrics, printMetrics } from './metrics.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(path.join(dir, '..', 'projects.json'), 'utf8'))
const [cmd, ...rest] = process.argv.slice(2)
const json = rest.includes('--json')
const key = rest.find((a) => !a.startsWith('--')) ?? 'valor'
const project = cfg.projects[key]
if (!project) { console.error(`unknown project "${key}"`); process.exit(1) }

const db = openDb()
const client = makeClient(process.env.CELO_RPC_URL || cfg.rpc)

if (cmd === 'index') await indexProject({ db, client, cfg, key, project })
else if (cmd === 'verify') await checkVerified({ db, client, cfg, key, project })
else if (cmd === 'report') {
  const m = buildMetrics(db, key, project)
  json ? console.log(JSON.stringify(m, null, 2)) : printMetrics(m)
} else if (cmd === 'publish') {
  // Writes the static dashboard feed. The Valor admin page and public/index.html both read this file.
  const m = buildMetrics(db, key, project)
  const out = JSON.stringify(m)
  writeFileSync(path.join(dir, '..', 'public', `${key}.json`), out) // read by the Valor admin page
  writeFileSync(path.join(dir, '..', 'docs', `${key}.json`), out) // read by the GitHub Pages dashboard (docs/index.html)
  console.log(`wrote public/${key}.json and docs/${key}.json`)
} else {
  console.error('usage: cli.mjs index|verify|report|publish [project] [--json]')
  process.exit(1)
}
