import { db } from "../db/index.js";
import { requests, routingDecisions } from "../db/schema.js";

/**
 * Metering: one `requests` row per API call and one `routing_decisions` row
 * per dispatch plan. Cost is OpenRouter's own reported `usage.cost` when the
 * backend supplies it, else a config-constant estimate — both are flagged in
 * the response so nothing pretends to be more exact than it is.
 */

export type PlanStep = {
  backendId: string;
  action: "served" | "skipped" | "failed" | "abandoned" | "blocked_policy";
  reason: string;
};

export type MeteredResult = {
  tenantId: number;
  capability: string;
  apiKeyId?: number;
  keyLabel?: string;
  backendId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** Time to first token, ms from request start; absent when none streamed. */
  ttftMs?: number;
  estimatedCostUsd: number;
  outcome: "ok" | "refused" | "failed" | "quota_denied";
  error?: string;
  retrievedCount?: number;
  intent?: string;
  confidence?: number;
  /** Turn trace — stored with the metering row for the console's trace viewer. */
  question?: string;
  answer?: string;
  retrievalJson?: string;
  chatSessionUid?: number;
};

export async function recordRequest(result: MeteredResult, requestId: string): Promise<void> {
  try {
    await db.insert(requests).values({ id: requestId, ...result, createdAt: new Date().toISOString() });
  } catch (err) {
    // Metering must never take the request path down, but it must be loud.
    console.error({ msg: "metering write failed", requestId, err: String(err) });
  }
}

export type PlanRecord = {
  requestId: string;
  tenantId: number;
  capability: string;
  plan: PlanStep[];
  chosenBackendId?: string;
  fallbackTriggered: boolean;
};

export async function recordRoutingDecision(rec: PlanRecord): Promise<void> {
  try {
    await db.insert(routingDecisions).values({
      requestId: rec.requestId,
      tenantId: rec.tenantId,
      capability: rec.capability,
      planJson: JSON.stringify(rec.plan),
      chosenBackendId: rec.chosenBackendId ?? null,
      fallbackTriggered: rec.fallbackTriggered,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error({ msg: "routing decision write failed", requestId: rec.requestId, err: String(err) });
  }
}