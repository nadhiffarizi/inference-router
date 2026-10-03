import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Metering + quota + routing: every row exists because the brief measures it. */

export const tenants = sqliteTable("tenants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  requestsPerDay: integer("requests_per_day").notNull(),
  tokensPerDay: integer("tokens_per_day").notNull(),
  /** Daily spend budget in USD — quota currency is dollars (admin/team decision 2026-10-03). */
  budgetUsdPerDay: real("budget_usd_per_day").notNull().default(1.0),
  createdAt: text("created_at").notNull(),
});

/**
 * Console operators. Every user belongs to exactly one tenant — admin is a
 * tenant like any other; its role only adds the Observability menu and
 * cross-tenant read access, nothing changes in the tenancy model.
 */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  /** scrypt: "salt:hex" format (node:crypto, no dependency). */
  passwordHash: text("password_hash").notNull(),
  /** admin | product */
  role: text("role").notNull(),
  tenantId: integer("tenant_id").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Opaque session tokens (cookie value = token); long-lived by design for this demo. */
export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Keys stored as SHA-256 hex — plaintext never touches the DB; masked copy for display. */
export const apiKeys = sqliteTable("api_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  maskedKey: text("masked_key").notNull().default(""),
  label: text("label").notNull(),
  createdAt: text("created_at").notNull(),
});

export const requests = sqliteTable("requests", {
  id: text("id").primaryKey(), // requestId (uuid)
  tenantId: integer("tenant_id").notNull(),
  capability: text("capability").notNull(), // chat | support-assistant
  /** Issued-key identity — usage is tracked per key NAME (openrouter-style). */
  apiKeyId: integer("api_key_id"),
  keyLabel: text("key_label"),
  backendId: text("backend_id").notNull(), // which backend served (or none)
  modelId: text("model_id").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  estimatedCostUsd: real("estimated_cost_usd").notNull().default(0),
  /** ok | refused | failed | quota_denied */
  outcome: text("outcome").notNull(),
  error: text("error"),
  /** Assistant-only columns; null for plain chat. */
  retrievedCount: integer("retrieved_count"),
  intent: text("intent"),
  confidence: real("confidence"),
  createdAt: text("created_at").notNull(),
});

/**
 * One row per request: the ordered candidate plan and what happened to each.
 * This is what makes routing "recorded and inspectable" (brief, Routing).
 */
export const routingDecisions = sqliteTable("routing_decisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("request_id").notNull(),
  tenantId: integer("tenant_id").notNull(),
  capability: text("capability").notNull(),
  planJson: text("plan_json").notNull(), // [{backendId, action: served|skipped|failed|abandoned, reason}]
  chosenBackendId: text("chosen_backend_id"),
  fallbackTriggered: integer("fallback_triggered", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

/** Per-tenant per-day counters. Fails closed: over limit → 429. */
export const quotaUsage = sqliteTable("quota_usage", {
  tenantId: integer("tenant_id").notNull(),
  day: text("day").notNull(), // YYYY-MM-DD in UTC
  requestCount: integer("request_count").notNull().default(0),
  tokensTotal: integer("tokens_total").notNull().default(0),
});

/** The Bitext slice backing the support assistant (DECISIONS.md D7). */
export const kbEntries = sqliteTable("kb_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  intent: text("intent").notNull(),
  category: text("category").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});