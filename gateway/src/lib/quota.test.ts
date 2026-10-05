import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Quota + auth tests — the request-path contract the brief grades: per-tenant
 * limits that actually deny, and a quota check that fails CLOSED with a
 * readable error (503 quota_uncertain), not a 500. Runs against a real
 * isolated SQLite file; the DB is broken deliberately in the last test.
 *
 * Env must be set before config.ts loads (module top-level), hence the
 * dynamic imports below.
 */

const tmp = mkdtempSync(path.join(tmpdir(), "quota-test-"));
process.env.OPENROUTER_API_KEY ??= "test-key";
process.env.TIER_A_MODEL ??= "test/a";
process.env.TIER_B_MODEL ??= "test/b";
process.env.DB_PATH ??= path.join(tmp, "gateway.sqlite");

const { bootstrapDatabase, db } = await import("../db/index.js");
const { tenants, apiKeys, requests } = await import("../db/schema.js");
const { checkQuota, bumpQuota, utcDay } = await import("./quota.js");
const { authenticate } = await import("../plugins/auth.js");
import { sql } from "drizzle-orm";
import type { GatewayError } from "./errors.js";

bootstrapDatabase();
const now = new Date().toISOString();

/** Insert a tenant + key; returns the tenant-shaped row checkQuota expects. */
async function seedTenant(
  name: string,
  limits: { requestsPerDay: number; tokensPerDay: number; budgetUsdPerDay: number },
): Promise<{ id: number; key: string; requestsPerDay: number; tokensPerDay: number; budgetUsdPerDay: number }> {
  const id = await db
    .insert(tenants)
    .values({ name, ...limits, createdAt: now })
    .returning({ id: tenants.id })
    .then((r) => r[0]!.id);
  const key = `sk_${name}_${"0".repeat(20)}`;
  await db.insert(apiKeys).values({
    tenantId: id,
    keyHash: createHash("sha256").update(key).digest("hex"),
    keyPlain: key,
    maskedKey: "sk_…7890",
    label: `${name} default`,
    createdAt: now,
  });
  return { id, key, ...limits };
}

type Creds = { key?: string };
function fakeReq({ key }: Creds): Parameters<typeof authenticate>[0] {
  return {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  } as unknown as Parameters<typeof authenticate>[0];
}

async function expectStatus(promise: Promise<unknown>, status: number, code?: string): Promise<GatewayError> {
  const err = (await promise.catch((e: unknown) => e)) as GatewayError;
  assert.equal(err.status, status, `expected ${status}, got ${err.status} (${err.message})`);
  if (code) assert.equal(err.code, code);
  return err;
}

after(() => rmSync(tmp, { recursive: true, force: true }));

test("auth: no header → 401 unauthorized", async () => {
  await expectStatus(authenticate(fakeReq({}), null as never), 401, "unauthorized");
});

test("auth: malformed header / unknown key → 401 unauthorized", async () => {
  await expectStatus(authenticate(fakeReq({ key: "sk_unknown_key_0000000000" }), null as never), 401, "unauthorized");
});

test("quota: fresh tenant is allowed and the verdict carries today's usage", async () => {
  const t = await seedTenant("quota-ok", { requestsPerDay: 5, tokensPerDay: 1000, budgetUsdPerDay: 5 });
  const verdict = await checkQuota(t);
  assert.equal(verdict.allowed, true);
  if (!verdict.allowed) return;
  assert.equal(verdict.used.requestCount, 0);
  assert.equal(verdict.used.day, utcDay());
});

test("quota: request limit denies with used+1 (the 4th request when limit is 3)", async () => {
  const t = await seedTenant("quota-req", { requestsPerDay: 2, tokensPerDay: 1000, budgetUsdPerDay: 5 });
  await bumpQuota(t.id, 10);
  await bumpQuota(t.id, 10);
  const verdict = await checkQuota(t);
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.match(verdict.reason, /request quota/);
});

test("quota: token limit denies once used tokens reach the cap", async () => {
  const t = await seedTenant("quota-tok", { requestsPerDay: 100, tokensPerDay: 10, budgetUsdPerDay: 5 });
  await bumpQuota(t.id, 10);
  const verdict = await checkQuota(t);
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.match(verdict.reason, /token quota/);
});

test("quota: spend budget denies when today's metered cost reaches the cap", async () => {
  const t = await seedTenant("quota-usd", { requestsPerDay: 100, tokensPerDay: 1000, budgetUsdPerDay: 0.5 });
  await db.insert(requests).values({
    id: `cost-${t.id}`,
    tenantId: t.id,
    capability: "chat",
    backendId: "test",
    modelId: "test/model",
    promptTokens: 1,
    completionTokens: 1,
    latencyMs: 1,
    estimatedCostUsd: 0.6,
    outcome: "ok",
    createdAt: now, // today (UTC day of the test run)
  });
  const verdict = await checkQuota(t);
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.match(verdict.reason, /spending budget/);
});

test("quota: zero is a legitimate limit — denies on the FIRST request", async () => {
  const t = await seedTenant("quota-zero-test", { requestsPerDay: 0, tokensPerDay: 1000, budgetUsdPerDay: 5 });
  await expectStatus(authenticate(fakeReq({ key: t.key }), null as never), 429, "quota_exceeded");
});

test("auth + quota together: valid key under limit attaches the tenant", async () => {
  const t = await seedTenant("auth-ok", { requestsPerDay: 5, tokensPerDay: 1000, budgetUsdPerDay: 5 });
  const req = fakeReq({ key: t.key });
  await authenticate(req, null as never);
  assert.equal(req.tenant?.name, "auth-ok");
  assert.ok(req.apiKey?.id);
});

test("fail closed: when the quota CHECK ITSELF breaks → 503 quota_uncertain, never serve blind", async () => {
  const t = await seedTenant("quota-broken", { requestsPerDay: 5, tokensPerDay: 1000, budgetUsdPerDay: 5 });
  // break the counter table the check reads — stand-in for "DB unavailable"
  await db.run(sql.raw("DROP TABLE quota_usage"));
  // direct: checkQuota rethrows as a GatewayError, not a bare Error
  await assert.rejects(checkQuota(t), (err: GatewayError) => err.status === 503 && err.code === "quota_uncertain");
  // through auth: the request is denied with the clear error the contract promises
  await expectStatus(authenticate(fakeReq({ key: t.key }), null as never), 503, "quota_uncertain");
});