import { createPublicClient, http, parseAbiItem } from 'viem'
import { claimedWallets } from './metrics.mjs'
import { celo } from 'viem/chains'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

export function makeClient(rpc) {
  return createPublicClient({ chain: celo, transport: http(rpc, { retryCount: 5, retryDelay: 500, batch: { batchSize: 50, wait: 10 } }) })
}

// First block at or after a unix timestamp (binary search; Celo blocks are ~1s).
export async function blockAtOrAfter(client, ts) {
  let lo = 1n
  let hi = await client.getBlockNumber()
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const b = await client.getBlock({ blockNumber: mid })
    if (Number(b.timestamp) < ts) lo = mid + 1n
    else hi = mid
  }
  return lo
}

// getLogs over a range, halving the window when the RPC rejects it as too large.
async function getLogsAdaptive(client, params, from, to) {
  try {
    return await client.getLogs({ ...params, fromBlock: from, toBlock: to })
  } catch (e) {
    if (to <= from) throw e
    const mid = (from + to) / 2n
    return [
      ...(await getLogsAdaptive(client, params, from, mid)),
      ...(await getLogsAdaptive(client, params, mid + 1n, to)),
    ]
  }
}

export async function indexProject({ db, client, cfg, key, project, log = console.log }) {
  const addrs = Object.values(project.contracts).map((a) => a.toLowerCase())
  const addrSet = new Set(addrs.map((a) => a.toLowerCase()))
  const head = await client.getBlockNumber()
  const cur = db.prepare('SELECT last_block FROM cursor WHERE project = ?').get(key)
  let from = cur
    ? BigInt(cur.last_block) + 1n
    : await blockAtOrAfter(client, Math.floor(new Date(project.startDate).getTime() / 1000))
  const STEP = 5_000n // Forno rejects getLogs ranges above 5000 blocks
  const PARALLEL = 8n

  const insLog = db.prepare('INSERT OR IGNORE INTO logs VALUES (?,?,?,?,?,?,?,?,?,?)')
  const insFlow = db.prepare('INSERT OR IGNORE INTO gd_flows VALUES (?,?,?,?,?,?,?,?)')
  const setCur = db.prepare('INSERT INTO cursor VALUES (?,?) ON CONFLICT(project) DO UPDATE SET last_block = excluded.last_block')
  const gd = cfg.gdToken.toLowerCase()

  while (from <= head) {
    // Fetch PARALLEL consecutive windows at once, then write them in order so the cursor stays contiguous.
    const windows = []
    for (let i = 0n; i < PARALLEL && from + i * STEP <= head; i++) {
      const a = from + i * STEP
      windows.push([a, a + STEP - 1n > head ? head : a + STEP - 1n])
    }
    const fetched = await Promise.all(windows.map(async ([a, b]) => {
      const [own, inbound, outbound] = await Promise.all([
        getLogsAdaptive(client, { address: addrs }, a, b),
        getLogsAdaptive(client, { address: gd, event: TRANSFER, args: { to: addrs } }, a, b),
        getLogsAdaptive(client, { address: gd, event: TRANSFER, args: { from: addrs } }, a, b),
      ])
      return { own, inbound, outbound }
    }))
    db.exec('BEGIN')
    for (const { own, inbound, outbound } of fetched) {
      for (const l of own) {
        insLog.run(key, Number(l.blockNumber), l.logIndex, l.transactionHash, l.address.toLowerCase(),
          l.topics[0] ?? null, l.topics[1] ?? null, l.topics[2] ?? null, l.topics[3] ?? null, l.data)
      }
      for (const [list, dir] of [[inbound, 'in'], [outbound, 'out']]) {
        for (const l of list) {
          const { from: f, to: t, value } = l.args
          const contract = (dir === 'in' ? t : f).toLowerCase()
          const wallet = (dir === 'in' ? f : t).toLowerCase()
          if (addrSet.has(wallet)) continue // contract-to-contract moves are not player activity
          insFlow.run(key, Number(l.blockNumber), l.logIndex, l.transactionHash, contract, wallet, dir, value.toString())
        }
      }
    }
    const last = windows[windows.length - 1][1]
    setCur.run(key, Number(last))
    db.exec('COMMIT')
    if (Number((last - (cur ? BigInt(cur.last_block) : 0n)) / STEP) % 20 < Number(PARALLEL)) log(`[${key}] indexed to block ${last} / ${head}`)
    from = last + 1n
  }
  await fillBlockTimes({ db, client, key, log })
}

// Timestamps for every block that has a project log or flow.
async function fillBlockTimes({ db, client, key, log }) {
  const need = db.prepare(`
    SELECT block FROM (
      SELECT block FROM logs WHERE project = ? UNION SELECT block FROM gd_flows WHERE project = ?
    ) WHERE block NOT IN (SELECT block FROM blocks)`).all(key, key).map((r) => BigInt(r.block))
  const ins = db.prepare('INSERT OR IGNORE INTO blocks VALUES (?,?)')
  for (let i = 0; i < need.length; i += 200) {
    const batch = await Promise.all(need.slice(i, i + 200).map((n) => client.getBlock({ blockNumber: n })))
    db.exec('BEGIN')
    for (const b of batch) ins.run(Number(b.number), Number(b.timestamp))
    db.exec('COMMIT')
    if ((i / 200) % 5 === 0) log(`[${key}] block times ${i}/${need.length}`)
  }
}

const IDENTITY_ABI = [parseAbiItem('function getWhitelistedRoot(address) view returns (address)')]
const ZERO = '0x0000000000000000000000000000000000000000'

// Live whitelist state for every wallet seen. Always a snapshot: GoodDollar un-whitelists over time.
export async function checkVerified({ db, client, cfg, key, project, log = console.log }) {
  // Players are decided by (character claimed AND whitelisted), so check every claimant, plus G$ movers for context.
  const flowWallets = db.prepare('SELECT DISTINCT wallet FROM gd_flows WHERE project = ?').all(key).map((r) => r.wallet)
  const wallets = [...new Set([...claimedWallets(db, key, project), ...flowWallets])]
  const up = db.prepare('INSERT INTO verified VALUES (?,?,?) ON CONFLICT(wallet) DO UPDATE SET is_verified = excluded.is_verified, checked_at = excluded.checked_at')
  const now = Math.floor(Date.now() / 1000)
  for (let i = 0; i < wallets.length; i += 200) {
    const slice = wallets.slice(i, i + 200)
    const res = await client.multicall({
      allowFailure: true,
      contracts: slice.map((w) => ({ address: cfg.identity, abi: IDENTITY_ABI, functionName: 'getWhitelistedRoot', args: [w] })),
    })
    db.exec('BEGIN')
    res.forEach((r, j) => {
      if (r.status === 'success') up.run(slice[j], r.result.toLowerCase() !== ZERO ? 1 : 0, now)
    })
    db.exec('COMMIT')
    log(`[${key}] verified check ${Math.min(i + 200, wallets.length)}/${wallets.length}`)
  }
}
