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
