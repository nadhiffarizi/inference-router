import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type CaseResult, type EvalCase, type RunSummary } from "./data.js";

/**
 * Eval harness: run the held-out slice through /v1/support-assistant and
 * produce raw per-case results. Two runs (A = tier A pinned, B = tier B
 * pinned) then `compare.ts` renders the A/B table (DECISIONS.md D8).
 *
 * Backend pinning goes through the gateway itself (body.backendPin) so eval
 * exercises the REAL request path — auth, quota, metering — not a bypass.
 */

const GATEWAY = process.env.GATEWAY_URL?.trim() || "http://localhost:8787";
const TENANT_KEY = process.env.EVAL_TENANT_KEY?.trim() || "sk_demo_key_0000000000000000";
const PINS: Record<string, string> = { A: "openrouter-tier-a", B: "openrouter-tier-b" };
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 4);

async function runCase(pin: string, c: EvalCase): Promise<CaseResult> {
  const base: CaseResult = {
    question: c.question,
    expectedIntent: c.intent,
    detectedIntent: null,
    intentCorrect: false,
    refused: false,
    error: null,
    answer: "",
    retrievalConfidence: null,
    retrievedIntents: [],
    backend: null,
    model: null,
    fallbackTriggered: false,
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };

  const res = await fetch(`${GATEWAY}/v1/support-assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TENANT_KEY}` },
    body: JSON.stringify({ message: c.question, backendPin: pin }),
  });

  // Non-stream failures (quota/auth/validation) — record and move on.
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    base.error = data?.error ? `${data.error.code}: ${data.error.message}` : `HTTP ${res.status}`;
    return base;
  }

  // Parse the SSE stream.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: { type: string; data: Record<string, unknown> }[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let type = "";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data || !type || type === "stream_end") continue;
      try {
        events.push({ type, data: JSON.parse(data) as Record<string, unknown> });
      } catch {
        /* tolerate malformed frames */
      }
    }
  }

  const meta = events.find((e) => e.type === "meta");
  const final = events.find((e) => e.type === "final");
  const error = events.find((e) => e.type === "error");
  const deltas = events
    .filter((e) => e.type === "delta")
    .map((e) => String((e.data as { text?: string }).text ?? ""))
    .join("");

  const metaD = (meta?.data ?? {}) as {
    backend?: { id: string; model: string };
    fallbackTriggered?: boolean;
    retrieval?: { confidence: number; entries: { intent: string }[] };
  };
  const finalD = (final?.data ?? {}) as {
    refused?: boolean;
    message?: string;
    metering?: {
      tokens?: { prompt?: number; completion?: number };
      latencyMs?: number;
      estimatedCostUsd?: number;
    };
  };

  if (error) {
    const e = error.data as { error?: { code?: string; message?: string } };
    base.error = e.error ? `${e.error.code}: ${e.error.message}` : "stream error";
  }

  // Intent is present in both meta (retrieval-derived) and final; refuse-only
  // responses carry it in final only. Prefer final, fall back to meta.
  const intentOf = (d: Record<string, unknown> | undefined): string | null =>
    (d as { intent?: { intent: string | null } } | undefined)?.intent?.intent ?? null;
  base.detectedIntent = intentOf(final?.data) ?? intentOf(meta?.data);
  base.refused = finalD.refused === true;
  base.answer = finalD.refused ? finalD.message ?? "" : deltas || finalD.message || "";
  base.retrievalConfidence = metaD.retrieval?.confidence ?? null;
  base.retrievedIntents = (metaD.retrieval?.entries ?? []).map((e) => e.intent);
  base.backend = metaD.backend?.id ?? null;
  base.model = metaD.backend?.model ?? null;
  base.fallbackTriggered = metaD.fallbackTriggered ?? false;
  base.latencyMs = finalD.metering?.latencyMs ?? 0;
  base.promptTokens = finalD.metering?.tokens?.prompt ?? 0;
  base.completionTokens = finalD.metering?.tokens?.completion ?? 0;
  base.costUsd = finalD.metering?.estimatedCostUsd ?? 0;
  base.intentCorrect = base.detectedIntent === c.intent;
  return base;
}

function percentile(latencies: number[], p: number): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

async function mapPool<T, R>(items: T[], pool: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(pool, items.length) }, worker));
  return out;
}

export async function runConfig(configName: string): Promise<RunSummary> {
  const pin = PINS[configName];
  if (!pin) throw new Error(`unknown config ${configName} (use A or B)`);
  const evalPath = path.resolve("../gateway/data/eval.json");
  const cases = JSON.parse(readFileSync(evalPath, "utf8")) as EvalCase[];
  const startedAt = new Date().toISOString();

  const results = await mapPool(cases, CONCURRENCY, (c) => runCase(pin, c));

  const okCases = results.filter((r) => !r.error);
  const grounded =
    await import("./judge.js").then((m) => m.judgeAll(results)).catch((err) => {
      console.warn(`judge unavailable (${String(err)}) — groundedness omitted`);
      return null;
    });
  if (grounded) for (const r of results) {
    const g = grounded.get(r.question);
    if (g) {
      r.groundednessScore = g.score;
      r.judgeComment = g.comment;
    }
  }

  const latencies = okCases.map((r) => r.latencyMs);
  const summary: RunSummary = {
    config: configName,
    backendPin: pin,
    startedAt,
    cases: results,
    metrics: {
      intentAccuracy: results.filter((r) => r.intentCorrect).length / results.length,
      refusalRate: results.filter((r) => r.refused).length / results.length,
      avgLatencyMs: latencies.reduce((s, l) => s + l, 0) / Math.max(1, latencies.length),
      p95LatencyMs: percentile(latencies, 95),
      totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
      avgGroundedness:
        grounded && results.some((r) => r.groundednessScore !== undefined)
          ? results.reduce((s, r) => s + (r.groundednessScore ?? 0), 0) / results.filter((r) => r.groundednessScore).length
          : null,
      errorRate: results.filter((r) => r.error).length / results.length,
    },
  };

  const outDir = path.resolve("results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `config-${configName}.json`), JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1]?.endsWith("run.ts")) {
  const argv = process.argv.slice(2).join(" ");
  const cfg = argv.match(/--config\s+([\w-]+)/)?.[1] ?? "A";
  runConfig(cfg)
    .then((s) => {
      console.log(`config ${s.config}: intent ${(s.metrics.intentAccuracy * 100).toFixed(0)}% · refusal ${(s.metrics.refusalRate * 100).toFixed(0)}% · avg ${s.metrics.avgLatencyMs.toFixed(0)}ms · $${s.metrics.totalCostUsd.toFixed(5)} · errors ${(s.metrics.errorRate * 100).toFixed(0)}%`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}