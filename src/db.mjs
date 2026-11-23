import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))

export function openDb(file = path.join(dir, '..', 'data', 'analytics.db')) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS logs (
      project TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
      tx_hash TEXT NOT NULL, address TEXT NOT NULL, topic0 TEXT,
      topic1 TEXT, topic2 TEXT, topic3 TEXT, data TEXT,
      PRIMARY KEY (project, block, log_index)
    );
    -- G$ Transfer logs that touch a project contract (wallet <-> contract flows)
    CREATE TABLE IF NOT EXISTS gd_flows (
      project TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
      tx_hash TEXT NOT NULL, contract TEXT NOT NULL, wallet TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')), amount TEXT NOT NULL,
      PRIMARY KEY (project, block, log_index)
    );
    -- G$ Transfer logs INTO a project's revenue wallets (e.g. the withdrawal-fee treasury).
    -- Kept apart from gd_flows: these wallets are not game contracts, so they must not count as play.
    CREATE TABLE IF NOT EXISTS revenue_flows (
      project TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
      tx_hash TEXT NOT NULL, revenue_wallet TEXT NOT NULL, from_wallet TEXT NOT NULL, amount TEXT NOT NULL,
      tx_sender TEXT NOT NULL, -- who sent the tx: a relay means the app moved it (a real fee), anyone else is a manual transfer
      PRIMARY KEY (project, block, log_index)
    );
    -- Prize programs (seasons, referral campaigns) by id. A prize payout's on-chain reference is derived from
    -- its program id, so these ids are what tell a prize apart from a gameplay reward.
    CREATE TABLE IF NOT EXISTS programs (
      project TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      starts_at TEXT, ends_at TEXT,
      PRIMARY KEY (project, kind, id)
    );
    CREATE TABLE IF NOT EXISTS blocks (block INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cursor (project TEXT PRIMARY KEY, last_block INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS verified (
      wallet TEXT PRIMARY KEY, is_verified INTEGER NOT NULL, checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_tx ON logs(project, tx_hash);
    CREATE INDEX IF NOT EXISTS idx_flows_wallet ON gd_flows(project, wallet);
  `)
  return db
}
