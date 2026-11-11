import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { decodeEventLog, getEventSelector } from 'viem'

const DAY = 86400
const ZERO = '0x0000000000000000000000000000000000000000'
const dir = path.dirname(fileURLToPath(import.meta.url))

const gd = (wei) => Number(BigInt(wei) / 10n ** 15n) / 1000 // wei -> G$ (3dp)
const dayKey = (ts) => new Date(ts * 1000).toISOString().slice(0, 10)
const weekKey = (ts) => Math.floor((ts + 3 * DAY) / (7 * DAY)) // weeks start Monday (epoch day 0 was a Thursday)
const weekStart = (wk) => dayKey(wk * 7 * DAY - 3 * DAY)
const tsOf = (d) => Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000)

export function loadAbis(project) {
  const byAddr = new Map()
  for (const [name, addr] of Object.entries(project.contracts)) {
    const file = project.abis?.[name]
    if (!file) continue
    const raw = JSON.parse(readFileSync(path.join(dir, '..', 'abis', `${file}.abi.json`), 'utf8'))
    byAddr.set(addr.toLowerCase(), { name, abi: Array.isArray(raw) ? raw : raw.abi })
  }
  return byAddr
}

// topic0 of an event, used to find wallets without decoding every log
export function selectorOf(abi, eventName) {
  return getEventSelector(abi.find((x) => x.type === 'event' && x.name === eventName))
}

export function claimedWallets(db, key, project) {
  const abis = loadAbis(project)
  const rec = [...abis.entries()].find(([, v]) => v.name === 'ValorGameRecord')
  if (!rec) return []
  const sel = selectorOf(rec[1].abi, 'CharacterClaimed')
  return db.prepare('SELECT DISTINCT topic1 FROM logs WHERE project = ? AND address = ? AND topic0 = ?')
    .all(key, rec[0], sel).map((r) => '0x' + r.topic1.slice(26))
}

// Decode every stored log once. Unknown or undecodable logs are skipped.
function decodeAll(db, key, project) {
  const abis = loadAbis(project)
  const rows = db.prepare(`
    SELECT l.address, l.tx_hash, l.topic0, l.topic1, l.topic2, l.topic3, l.data, b.ts
    FROM logs l JOIN blocks b ON b.block = l.block WHERE l.project = ? ORDER BY l.block, l.log_index`).all(key)
  const out = []
  for (const r of rows) {
    const c = abis.get(r.address)
    if (!c) continue
    const topics = [r.topic0, r.topic1, r.topic2, r.topic3].filter(Boolean)
    try {
      const ev = decodeEventLog({ abi: c.abi, data: r.data, topics })
      out.push({ contract: c.name, event: ev.eventName, args: ev.args, ts: r.ts, tx: r.tx_hash })
    } catch { /* not in ABI */ }
  }
  return out
}

export function buildMetrics(db, key, project, now = Math.floor(Date.now() / 1000)) {
  const startTs = tsOf(project.startDate)
  const contractSet = new Set(Object.values(project.contracts).map((a) => a.toLowerCase()))
  const excluded = new Map(Object.entries(project.excludeWallets ?? {}).map(([a, l]) => [a.toLowerCase(), l]))
  const events = decodeAll(db, key, project)

  // Pool funders are team wallets, never players: exclude them automatically and say so.
  for (const e of events) {
    if (e.event === 'FundsDeposited') {
      const w = e.args.from.toLowerCase()
      if (!excluded.has(w)) excluded.set(w, 'pool funder (auto: FundsDeposited)')
    }
  }
  const isPlayerish = (w) => w && w !== ZERO && !contractSet.has(w) && !excluded.has(w)

  // ---- who is a player: claimed a character AND currently GoodDollar-verified
  const claimTs = new Map() // wallet -> first claim ts
  for (const e of events) {
    if (e.event !== 'CharacterClaimed') continue
    const w = e.args.player.toLowerCase()
    if (isPlayerish(w) && !claimTs.has(w)) claimTs.set(w, e.ts)
  }
  const ver = new Map(db.prepare('SELECT wallet, is_verified, checked_at FROM verified').all().map((r) => [r.wallet, r]))
  const verifiedAt = Math.max(0, ...[...ver.values()].map((v) => v.checked_at))
  // A player counts from the later of: character claimed, GoodDollar verification recorded on-chain
  // (VerificationRecorded). Wallets verified before the event existed fall back to their claim time.
  const verTs = new Map()
  for (const e of events) {
    if (e.event !== 'VerificationRecorded') continue
    const w = e.args.wallet.toLowerCase()
    if (!verTs.has(w)) verTs.set(w, e.ts)
  }
  // Verified = GoodDollar verification was recorded on-chain by Valor, OR the wallet is whitelisted right now.
  // The live whitelist alone undercounts: GoodDollar lapses whitelists within days, so people who did verify drop out.
  // VerificationRecorded only exists since 2026-08-26; earlier verifications are only visible if still whitelisted.
  const isVerified = (w) => verTs.has(w) || ver.get(w)?.is_verified === 1
  const players = new Set([...claimTs.keys()].filter(isVerified))
  const playerSince = (w) => Math.max(claimTs.get(w), verTs.get(w) ?? 0)

  // ---- activity: every event a real wallet takes part in (played, bought, earned, sent or received G$)
  const act = [] // {w, ts}
  const push = (w, ts) => { w = w?.toLowerCase(); if (isPlayerish(w)) act.push({ w, ts }) }
  for (const e of events) {
    const a = e.args
    switch (e.event) {
      case 'CharacterClaimed': case 'AttemptStarted': case 'RankUp': case 'RewardDistributed': case 'DailyClaimDistributed': case 'BountyDistributed':
        push(a.player, e.ts); break
      case 'BattleRecorded': push(a.winner, e.ts); push(a.loser, e.ts); break
      case 'ItemPurchased': push(a.buyer, e.ts); break
      case 'ResalePurchased': push(a.buyer, e.ts); push(a.seller, e.ts); break
      case 'ResaleListed': push(a.seller, e.ts); break
      case 'TransferSingle': case 'TransferBatch': push(a.from, e.ts); push(a.to, e.ts); break
    }
  }
  const flows = db.prepare(`
    SELECT f.contract, f.wallet, f.direction, f.amount, f.tx_hash, b.ts
    FROM gd_flows f JOIN blocks b ON b.block = f.block WHERE f.project = ?`).all(key)
  for (const f of flows) push(f.wallet, f.ts)

  // ---- transactions (every tx that touched a project contract, relay-sent included)
  const txTs = new Map()
  for (const e of events) if (!txTs.has(e.tx)) txTs.set(e.tx, e.ts)
  for (const f of flows) if (!txTs.has(f.tx_hash)) txTs.set(f.tx_hash, f.ts)

  // ---- money, excluding team wallets
  const poolAddrs = new Set((project.pools ?? []).map((n) => project.contracts[n].toLowerCase()))
  const mktAddr = project.contracts.ValorMarketplace?.toLowerCase()
  const money = [] // {ts, kind, g}
  for (const f of flows) {
    if (excluded.has(f.wallet)) continue
    const g = gd(f.amount)
    money.push({ ts: f.ts, kind: f.direction === 'in' ? 'in' : (poolAddrs.has(f.contract) ? 'reward' : 'mktOut'), g, w: f.wallet })
  }
  for (const e of events) {
    if (e.contract !== 'ValorMarketplace') continue
    if (e.event === 'ItemPurchased' && isPlayerish(e.args.buyer.toLowerCase())) money.push({ ts: e.ts, kind: 'mktSpend', g: gd(e.args.price), revenue: gd(e.args.price) })
    if (e.event === 'ResalePurchased' && isPlayerish(e.args.buyer.toLowerCase())) money.push({ ts: e.ts, kind: 'mktSpend', g: gd(e.args.price), revenue: gd(e.args.fee) })
  }
  const withdrawn = events.filter((e) => e.event === 'RevenueWithdrawn').reduce((s, e) => s + gd(e.args.amount), 0)

  // ---- helpers over a [from, to) window
  const inWin = (ts, a, b) => ts >= a && ts < b
  const sumKind = (kind, a, b, f = 'g') => money.filter((m) => m.kind === kind && inWin(m.ts, a, b)).reduce((s, m) => s + (m[f] ?? 0), 0)
  const moved = (a, b) => money.filter((m) => (m.kind === 'in' || m.kind === 'reward' || m.kind === 'mktOut') && inWin(m.ts, a, b)).reduce((s, m) => s + m.g, 0)
  const activePlayers = (a, b) => new Set(act.filter((x) => players.has(x.w) && inWin(x.ts, a, b)).map((x) => x.w))
  const activeAll = (a, b) => new Set(act.filter((x) => inWin(x.ts, a, b)).map((x) => x.w))
  const txCount = (a, b) => [...txTs.values()].filter((t) => inWin(t, a, b)).length
  const earnersIn = (a, b) => new Set(money.filter((m) => m.kind === 'reward' && inWin(m.ts, a, b)).map((m) => m.w))

  const FAR = 1e12
  const totals = {
    txs: txTs.size,
    txsLast7d: txCount(now - 7 * DAY, FAR), txsLast30d: txCount(now - 30 * DAY, FAR),
    charactersClaimed: claimTs.size,
    verifiedAmongClaimed: players.size,
    verifiedOnChainEvent: [...claimTs.keys()].filter((w) => verTs.has(w)).length,
    verifiedLiveOnly: [...claimTs.keys()].filter((w) => !verTs.has(w) && ver.get(w)?.is_verified === 1).length,
    players: players.size,
    wau: activePlayers(now - 7 * DAY, FAR).size,
    mau: activePlayers(now - 30 * DAY, FAR).size,
    activeAnyWalletMau: activeAll(now - 30 * DAY, FAR).size,
    battles: events.filter((e) => e.event === 'BattleRecorded').length,
    gMoved: moved(0, FAR),
    gSpentInApp: sumKind('in', 0, FAR),
    gSpentMarketplace: sumKind('mktSpend', 0, FAR),
    marketplacePurchases: money.filter((m) => m.kind === 'mktSpend').length,
    marketplaceRevenue: sumKind('mktSpend', 0, FAR, 'revenue'),
    marketplaceRevenueWithdrawn: withdrawn,
    rewardsPaid: sumKind('reward', 0, FAR),
    earners: earnersIn(0, FAR).size,
    itemsRegistered: events.filter((e) => e.event === 'ItemRegistered').length,
    verifiedCheckedAt: verifiedAt ? new Date(verifiedAt * 1000).toISOString() : null,
    walletsVerifyChecked: [...claimTs.keys()].filter((w) => ver.has(w)).length,
  }

  // ---- daily series from project start
  const days = []
  for (let t = startTs; t <= now; t += DAY) {
    const a = t, b = t + DAY
    days.push({
      date: dayKey(a),
      txs: txCount(a, b),
      newPlayers: [...players].filter((w) => inWin(playerSince(w), a, b)).length,
      activePlayers: activePlayers(a, b).size,
      gMoved: moved(a, b),
      gSpent: sumKind('in', a, b),
      marketplaceSpend: sumKind('mktSpend', a, b),
      rewards: sumKind('reward', a, b),
    })
  }

  // ---- weekly: active, new, WoW retention among players
  const byWeek = new Map()
  for (const x of act) {
    if (!players.has(x.w)) continue
    const wk = weekKey(x.ts)
    if (!byWeek.has(wk)) byWeek.set(wk, new Set())
    byWeek.get(wk).add(x.w)
  }
  const nowWk = weekKey(now)
  const weeks = [...byWeek.keys()].sort((a, b) => a - b)
  const weekly = weeks.map((wk) => {
    const cur = byWeek.get(wk), next = byWeek.get(wk + 1)
    const done = wk < nowWk // only completed weeks have a meaningful "next week"
    return {
      weekStart: weekStart(wk), active: cur.size,
      newPlayers: [...players].filter((w) => weekKey(playerSince(w)) === wk).length,
      retainedNextWeek: done ? [...cur].filter((w) => next?.has(w)).length : null,
    }
  })
  const lastDone = [...weekly].reverse().find((w) => w.retainedNextWeek !== null && w.active > 0)
  const latestRetentionPct = lastDone ? Math.round((1000 * lastDone.retainedNextWeek) / lastDone.active) / 10 : null

  // ---- Season
  let season = null
  if (project.season) {
    const s = project.season
    const sStart = tsOf(s.start)
    const sEnd = tsOf(s.epochEnds[s.epochEnds.length - 1]) + DAY
    const upto = Math.min(now + 1, sEnd)
    const started = now >= sStart
    const flow = started ? {
      txs: txCount(sStart, upto), gMoved: moved(sStart, upto), gSpent: sumKind('in', sStart, upto),
      revenue: sumKind('mktSpend', sStart, upto, 'revenue'), rewards: sumKind('reward', sStart, upto),
      earners: earnersIn(sStart, upto).size,
    } : { txs: 0, gMoved: 0, gSpent: 0, revenue: 0, rewards: 0, earners: 0 }
    const stock = {
      verifiedPlayers: totals.players, monthlyActive: totals.mau, weeklyActive: totals.wau,
      weeklyRetentionPct: latestRetentionPct,
    }
    const baseline = {
      verifiedPlayers: [...players].filter((w) => playerSince(w) < sStart).length,
      monthlyActive: activePlayers(sStart - 30 * DAY, sStart).size,
      weeklyActive: activePlayers(sStart - 7 * DAY, sStart).size,
    }
    const targets = Object.entries(s.targets).map(([id, t]) => {
      const actual = t.kind === 'offchain' ? null : (stock[id] ?? flow[id] ?? null)
      return {
        id, label: t.label, kind: t.kind, target: t.value, actual,
        baseline: baseline[id] ?? (t.kind === 'flow' ? 0 : null),
        pct: actual === null ? null : Math.round((1000 * actual) / t.value) / 10,
      }
    })
    let prev = sStart
    const epochs = s.epochEnds.map((end, i) => {
      const a = prev, b = tsOf(end) + DAY
      prev = b
      return {
        epoch: i + 1, start: dayKey(a), end,
        status: now >= b ? 'done' : now >= a ? 'live' : 'upcoming',
        txs: txCount(a, b), gMoved: moved(a, b), gSpent: sumKind('in', a, b), revenue: sumKind('mktSpend', a, b, 'revenue'),
        rewards: sumKind('reward', a, b), newPlayers: [...players].filter((w) => inWin(playerSince(w), a, b)).length,
        activePlayers: activePlayers(a, b).size,
      }
    })
    season = { name: s.name, start: s.start, end: s.epochEnds[s.epochEnds.length - 1], started, targets, epochs }
  }

  return {
    project: key, name: project.name, asOf: new Date(now * 1000).toISOString(), startDate: project.startDate,
    definitions: {
      player: 'A wallet that created a character (CharacterClaimed on ValorGameRecord) and is currently GoodDollar-whitelisted.',
      active: 'A player who played, bought, earned or sent/received G$ in the window, counted from contract events. Relay and team wallets excluded.',
      gMoved: 'G$ into plus out of Valor contracts, team wallets excluded.',
      gSpentInApp: 'G$ players sent into Valor contracts (marketplace, Gauntlet re-entry, pools).',
      revenue: 'On-chain marketplace revenue: primary sale prices plus resale fees. Withdrawal fee and duel house cut are not on this chain data.',
      offchain: 'Groups and Face-Off stakes are not in these contracts yet (groups live in the Valor database; duel escrow is not indexed).',
    },
    excludedWallets: [...excluded].map(([wallet, label]) => ({ wallet, label })),
    totals, days, weekly, latestRetentionPct, season,
  }
}

const fmt = (n) => (n === null || n === undefined ? 'n/a' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }))

export function printMetrics(m) {
  const p = (k, v) => console.log(`${k.padEnd(38)} ${v}`)
  const t = m.totals
  console.log(`\n${m.name.toUpperCase()} on-chain analytics (as of ${m.asOf})\n`)
  p('On-chain txs (all / 30d / 7d)', `${fmt(t.txs)} / ${fmt(t.txsLast30d)} / ${fmt(t.txsLast7d)}`)
  p('Characters claimed', fmt(t.charactersClaimed))
  p('Players (character + verified)', `${fmt(t.players)}${t.verifiedCheckedAt ? '' : '  (run verify first)'}`)
  p('Players active MAU / WAU', `${fmt(t.mau)} / ${fmt(t.wau)}`)
  p('Battles recorded', fmt(t.battles))
  p('G$ moved (team wallets excluded)', fmt(t.gMoved))
  p('G$ spent in app', fmt(t.gSpentInApp))
  p('  of which marketplace', `${fmt(t.gSpentMarketplace)} (${fmt(t.marketplacePurchases)} purchases)`)
  p('Marketplace revenue / withdrawn', `${fmt(t.marketplaceRevenue)} / ${fmt(t.marketplaceRevenueWithdrawn)}`)
  p('Rewards paid / earners', `${fmt(t.rewardsPaid)} / ${fmt(t.earners)}`)
  console.log('\nExcluded wallets:')
  m.excludedWallets.forEach((x) => console.log(`  ${x.wallet}  ${x.label}`))
  if (m.season) {
    console.log(`\n${m.season.name} (${m.season.start} to ${m.season.end})${m.season.started ? '' : '  [not started]'}`)
    for (const x of m.season.targets) console.log(`  ${x.label.padEnd(40)} ${fmt(x.actual).padStart(10)} / ${fmt(x.target).padStart(10)}  ${x.pct === null ? '' : x.pct + '%'}`)
  }
  console.log()
}
