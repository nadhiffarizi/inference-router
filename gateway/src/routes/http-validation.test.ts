import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
/** Same contract as light-my-request's inject.InjectPayload (not re-exported from fastify). */
type InjectPayload = string | object | Buffer | NodeJS.ReadableStream;

/**
 * HTTP-level request-path tests — the failure shapes the runbook (§10) and
 * the report's failure map promise, fired against a REAL Fastify app with the
 * production route+auth modules. server.ts isn't importable (main() runs on
 * import), so the app is assembled here with the same ajv config and a
 * replica of its error handler; validation, auth and the assistant handler
 * are production code.
 *
 * Pins the bug found live on 2026-10-05: Fastify's Ajv default
 * (removeAdditional:true) silently STRIPS unknown fields, so
 * additionalProperties:false never produced the promised 400 — an unknown
 * field streamed a full refusal response. The production factory now sets
 * removeAdditional:false; these tests hold it there.
 *
 * Env must be set before config.ts loads (module top-level), hence the
 * dynamic imports below.
 */

const tmp = mkdtempSync(path.join(tmpdir(), "http-test-"));
process.env.OPENROUTER_API_KEY ??= "test-key";
process.env.TIER_A_MODEL ??= "test/a";
process.env.TIER_B_MODEL ??= "test/b";
process.env.DB_PATH ??= path.join(tmp, "gateway.sqlite");

const { bootstrapDatabase, db } = await import("../db/index.js");
const { tenants, apiKeys, requests, routingDecisions } = await import("../db/schema.js");
const { authenticate } = await import("../plugins/auth.js");
const { registerAssistantRoute } = await import("./assistant.js");
const { GatewayError, errorBody } = await import("../lib/errors.js");
const { loadKb } = await import("../rag/kb.js");
const { eq } = await import("drizzle-orm");

bootstrapDatabase();
loadKb(); // empty KB: a valid request takes the refusal path — no adapter needed

const now = new Date().toISOString();
const tenantId = await db
  .insert(tenants)
  .values({ name: "http-test", requestsPerDay: 5, tokensPerDay: 1000, budgetUsdPerDay: 5, createdAt: now })
  .returning({ id: tenants.id })
  .then((r) => r[0]!.id);
const KEY = "sk_http_test_key_0000000000";
await db.insert(apiKeys).values({
  tenantId,
  keyHash: createHash("sha256").update(KEY).digest("hex"),
  keyPlain: KEY,
  maskedKey: "sk_…0000",
  label: "test key",
  createdAt: now,
});

/** The production app assembly, mirrored here because main() bootes itself. */
const app = Fastify({
  ajv: { customOptions: { removeAdditional: false } },
});
app.setErrorHandler((err: unknown, _req, reply) => {
  if (err instanceof GatewayError) {
    reply.status(err.status).send(errorBody(err.code, err.message, err.details));
    return;
  }
  type ValidationErr = { validation?: unknown[] };
  if ((err as ValidationErr).validation) {
    // mirror of server.ts's branch: Fastify schema violations → 400
    reply.status(400).send(errorBody("invalid_input", (err as Error).message, { violations: (err as ValidationErr).validation }));
    return;
  }
  reply.status(500).send(errorBody("internal", "internal error"));
});
registerAssistantRoute(app, new Map()); // empty registry: any reachable dispatch would fail loudly
app.addHook("onRequest", authenticate);

const AUTH = { authorization: `Bearer ${KEY}` };

async function inject(payload: InjectPayload, headers: Record<string, string> = AUTH) {
  return app.inject({ method: "POST", url: "/v1/support-assistant", headers, payload });
}

function eventPayload(text: string, event: string): string | undefined {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `event: ${event}`) return lines[i + 1]?.replace(/^data:\s*/, "");
  }
  return undefined;
}

after(() => rmSync(tmp, { recursive: true, force: true }));

test("validation: unknown field → 400 invalid_input (strict, never silently stripped)", async () => {
  const res = await inject({ message: "hi", unexpectedField: true });
  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body.slice(0, 200)}`);
  assert.equal(res.json<{ error: { code: string } }>().error.code, "invalid_input");
});

test("validation: >4000 chars, empty message → 400 invalid_input", async () => {
  for (const body of [{ message: "x".repeat(4001) }, { message: "" }]) {
    const res = await inject(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json<{ error: { code: string } }>().error.code, "invalid_input");
  }
});

test("auth: unknown key → 401 (runs before validation — a bad key can't probe anything)", async () => {
  const res = await inject({ message: "hi", unexpectedField: true }, { authorization: "Bearer sk_unknown_00000000" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json<{ error: { code: string } }>().error.code, "unauthorized");
});

test("auth: missing header → 401", async () => {
  const res = await inject({ message: "hi" }, {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.json<{ error: { code: string } }>().error.code, "unauthorized");
});

test("valid request through the whole path: refusal stream, SSE events, metering row written", async () => {
  // empty KB → confidence 0 → refusal gate before routing; no adapter is in
  // the registry, so this still exercises schema → auth → retrieve → refuse → meter
  const res = await inject({ message: "how do I cancel my order?", sessionId: "http-test-1" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /event: meta/);
  assert.match(res.body, /event: final/);
  assert.match(res.body, /event: stream_end/);
  const meta = JSON.parse(eventPayload(res.body, "meta")!);
  assert.equal(meta.refusal, true);
  assert.equal(meta.backend.id, "none");
  assert.equal(meta.routingPlan[0].action, "blocked_policy");
  const final = JSON.parse(eventPayload(res.body, "final")!);
  assert.equal(final.refused, true);
  // metering: the refusal-turn row exists, zero tokens, decision row persisted
  const row = db.select().from(requests).where(eq(requests.tenantId, tenantId)).all()[0];
  assert.equal(row?.outcome, "refused");
  assert.equal(row?.completionTokens, 0);
  const dec = db.select().from(routingDecisions).where(eq(routingDecisions.tenantId, tenantId)).all()[0];
  assert.ok(!dec?.fallbackTriggered); // boolean false (drizzle maps the 0/1 column)
  assert.ok(dec?.planJson.includes('"blocked_policy"'));
});