import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { config } from "../config.js";

export type Db = BetterSQLite3Database<Record<string, never>>;

const dbFile = path.resolve(config.dbPath);
if (path.dirname(dbFile)) mkdirSync(path.dirname(dbFile), { recursive: true });
const isFirstRun = !existsSync(dbFile);

const sqlite = new Database(dbFile);
sqlite.pragma("journal_mode = WAL");
/** Quota checks are read-modify-write; a busy DB must wait, not error open. */
sqlite.pragma("busy_timeout = 5000");

/**
 * Bootstrap DDL. The schema is small enough that drizzle-kit push is a
 * heavier hammer than needed; a single idempotent script on boot keeps
 * deployment to "copy files, run server".
 */
const DDL = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  requests_per_day INTEGER NOT NULL,
  tokens_per_day INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  capability TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  error TEXT,
  retrieved_count INTEGER,
  intent TEXT,
  confidence REAL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routing_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  capability TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  chosen_backend_id TEXT,
  fallback_triggered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_tenant ON requests (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_request ON routing_decisions (request_id);
CREATE TABLE IF NOT EXISTS quota_usage (
  tenant_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
CREATE TABLE IF NOT EXISTS kb_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  intent TEXT NOT NULL,
  category TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_intent ON kb_entries (intent);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const db: Db = drizzle(sqlite);

export function bootstrapDatabase(): void {
  sqlite.exec(DDL);
}

export function wasFreshDatabase(): boolean {
  return isFirstRun;
}