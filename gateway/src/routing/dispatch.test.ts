import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Dispatch tests — the fallback contract, in isolation. Backends are scripted
 * fakes so every failure shape (error, stall, empty-but-successful stream) is
 * deterministic; dispatch itself is exercised as the real production unit.
 *
 * Env must be set before config.ts loads (module top-level), hence the
 * dynamic imports below.
 */

const tmp = mkdtempSync(path.join(tmpdir(), "dispatch-test-"));
process.env.OPENROUTER_API_KEY ??= "test-key";
process.env.TIER_A_MODEL ??= "test/a";
process.env.TIER_B_MODEL ??= "test/b";
process.env.DB_PATH ??= path.join(tmp, "gateway.sqlite");

type StreamEvent = import("../backends/types.js").StreamEvent;
type AdapterMeta = import("../backends/types.js").AdapterMeta;
type ModelAdapter = import("../backends/types.js").ModelAdapter;

const { openWithFallback, adapterRegistry } = await import("./dispatch.js");
const { estimateCost } = await import("../backends/types.js");

const usage = (promptTokens = 1, completionTokens = 2) => ({ promptTokens, completionTokens });
let seq = 0;
function meta(id: string, tier: AdapterMeta["tier"]): AdapterMeta {
  seq += 1;
  return { id: `${id}-${seq}`, label: id, modelId: `${id}/model`, tier, timeoutMs: 60, pricePerMTokens: { input: 0.05, output: 0.45 } };
}

/** Backend that yields exactly the scripted events, then ends. */
function scripted(tier: AdapterMeta["tier"], events: StreamEvent[]): ModelAdapter {
  const m = meta("scripted", tier);
  return {
    meta: m,
    async *stream(): AsyncGenerator<StreamEvent, void, unknown> {
      yield* events;
    },
  };
}

/** Backend that throws immediately — upstream unreachable / 500. */
function failing(tier: AdapterMeta["tier"], message: string): ModelAdapter {
  const m = meta("failing", tier);
  return {
    meta: m,
    stream(): AsyncGenerator<StreamEvent, void, unknown> {
      return (async function* () {
        throw new Error(message);
        yield {} as StreamEvent; // unreachable — marks the generator as yielding
      })();
    },
  };
}

/** Backend whose first chunk stalls past the timeout, then would continue. */
function stalled(tier: AdapterMeta["tier"]): ModelAdapter {
  const m = meta("stalled", tier);
  return {
    meta: m,
    async *stream(): AsyncGenerator<StreamEvent, void, unknown> {
      await new Promise((r) => setTimeout(r, 400));
      yield { type: "delta", text: "too late" };
      yield { type: "done", usage: usage() };
    },
  };
}

after(() => rmSync(tmp, { recursive: true, force: true }));

test("first backend that completes with no delta is abandoned — the next candidate serves", async () => {
  // The success-shaped empty stream: done event arrives, zero deltas. This
  // used to be marked "served", burning the whole plan and short-changing the
  // caller.
  const outcome = await openWithFallback(
    [
      { adapter: scripted("mock", [{ type: "done", usage: usage() }]), reason: "head" },
      { adapter: scripted("a", [{ type: "delta", text: "an answer" }, { type: "done", usage: usage() }]), reason: "next" },
    ],
    { messages: [], maxTokens: 10 },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.chosen.meta.tier, "a");
  assert.equal(outcome.fallbackTriggered, true);
  assert.deepEqual(outcome.steps.map((s) => s.action), ["abandoned", "served"]);
  assert.match(outcome.steps[0]!.reason, /without output/);
  // the winner's deltas still reach the caller intact
  const received: StreamEvent[] = [];
  for await (const e of outcome.stream) received.push(e);
  assert.deepEqual(received.map((e) => (e.type === "delta" ? deltaText(e) : `done:${e.usage.completionTokens}`)), ["an answer", "done:2"]);
});

test("upstream throw → failed step + fallback to the next candidate", async () => {
  const outcome = await openWithFallback(
    [
      { adapter: failing("a", "upstream 503"), reason: "head" },
      { adapter: scripted("b", [{ type: "delta", text: "ok" }, { type: "done", usage: usage() }]), reason: "next" },
    ],
    { messages: [], maxTokens: 10 },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.fallbackTriggered, true);
  assert.deepEqual(outcome.steps.map((s) => s.action), ["failed", "served"]);
  assert.match(outcome.steps[0]!.reason, /upstream 503/);
});

test("backend that stalls past the timeout fails and falls back — the router guard, not the adapter", async () => {
  const outcome = await openWithFallback(
    [
      { adapter: stalled("a"), reason: "head" },
      { adapter: scripted("b", [{ type: "delta", text: "fast" }, { type: "done", usage: usage() }]), reason: "next" },
    ],
    { messages: [], maxTokens: 10 },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.steps.map((s) => s.action), ["failed", "served"]);
  assert.match(outcome.steps[0]!.reason, /stalled .* between chunks \(router timeout\)/);
});

test("head candidate answers → no fallback, and the unreachable tail is recorded as skipped", async () => {
  const outcome = await openWithFallback(
    [
      { adapter: scripted("a", [{ type: "delta", text: "hello" }, { type: "done", usage: usage() }]), reason: "strong retrieval" },
      { adapter: scripted("b", []), reason: "never" },
    ],
    { messages: [], maxTokens: 10 },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.fallbackTriggered, false);
  assert.deepEqual(outcome.steps.map((s) => s.action), ["served", "skipped"]);
  assert.match(outcome.steps[1]!.reason, /not reached/);
});

test("every candidate dead → ok:false, one failed step each, real error preserved", async () => {
  const outcome = await openWithFallback(
    [
      { adapter: failing("a", "a is dead"), reason: "head" },
      { adapter: failing("b", "b is dead too"), reason: "next" },
    ],
    { messages: [], maxTokens: 10 },
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.lastError, /b is dead too/);
  assert.deepEqual(outcome.steps.map((s) => s.action), ["failed", "failed"]);
});

test("adapterRegistry indexes adapters by id", () => {
  const a = scripted("a", []);
  const b = scripted("b", []);
  const reg = adapterRegistry([a, b]);
  assert.equal(reg.get(a.meta.id), a);
  assert.equal(reg.get(b.meta.id), b);
});

test("estimateCost prices tokens at per-M rates", () => {
  const price = { input: 1, output: 3 };
  assert.equal(estimateCost(price, { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 4);
  assert.equal(estimateCost(undefined, { promptTokens: 1, completionTokens: 1 }), 0);
});

function deltaText(e: StreamEvent): string {
  return e.type === "delta" ? e.text : "not-a-delta";
}