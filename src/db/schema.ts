/**
 * Offline Naira local SQLite schema, run once via db.execAsync() on open
 * (see connection.ts). expo-sqlite's execAsync() happily runs a whole
 * multi-statement string, so unlike a bare-RN project there's no need for
 * a separate build step to embed this — it's just a TS string.
 *
 * HARD RULE: no private key material, PIN, or biometric secret is ever
 * written to any table here. Keys live only in expo-secure-store
 * (see src/crypto/identity.ts). PIN is verified via a salted hash, never
 * stored/compared in plaintext.
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  offline_naira_id TEXT UNIQUE,
  display_name TEXT,
  pin_hash TEXT NOT NULL,
  biometric_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key_b64 TEXT NOT NULL,
  device_label TEXT,
  registered_at INTEGER NOT NULL,
  last_synced_at INTEGER
);

-- The wallet table is the LOCAL, POSSIBLY-STALE view of a spending cap.
-- It is never the source of truth; see docs/ARCHITECTURE.md.
CREATE TABLE IF NOT EXISTS wallet (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id),
  bank_balance_kobo INTEGER NOT NULL DEFAULT 0,
  offline_wallet_kobo INTEGER NOT NULL DEFAULT 0,
  reserved_kobo INTEGER NOT NULL DEFAULT 0,
  daily_sent_kobo INTEGER NOT NULL DEFAULT 0,
  daily_received_kobo INTEGER NOT NULL DEFAULT 0,
  daily_window_start INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  last_verified_at INTEGER,
  CHECK (bank_balance_kobo >= 0),
  CHECK (offline_wallet_kobo >= 0),
  CHECK (reserved_kobo >= 0)
);

CREATE TABLE IF NOT EXISTS transactions (
  tx_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('SENT', 'RECEIVED')),
  counterparty_device_id TEXT NOT NULL,
  counterparty_offline_naira_id TEXT,
  amount_kobo INTEGER NOT NULL CHECK (amount_kobo > 0),
  state TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  offered_at INTEGER,
  received_at INTEGER,
  committed_at INTEGER,
  confirmed_at INTEGER,
  settled_at INTEGER,
  failure_reason TEXT,
  signed_payload_json TEXT NOT NULL,
  receipt_json TEXT,
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tx_state ON transactions(state);
CREATE INDEX IF NOT EXISTS idx_tx_synced ON transactions(synced);

CREATE TABLE IF NOT EXISTS seen_nonces (
  nonce TEXT PRIMARY KEY,
  tx_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_settlements (
  tx_id TEXT PRIMARY KEY REFERENCES transactions(tx_id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS sync_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  tx_count INTEGER NOT NULL DEFAULT 0,
  success INTEGER,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  detail_json TEXT,
  occurred_at INTEGER NOT NULL
);
`;
