import { config } from "../config.js";
import { demoControls } from "../lib/demoControls.js";
import type { ModelAdapter } from "../backends/types.js";

/**
 * Routing rules (DECISIONS.md D5). Ordered, first-match-wins, and cheap: the
 * only inputs are signals the gateway already holds — retrieval confidence
 * (assistant capability) and question shape. No model call is spent deciding
 * which model to call: a router that runs an LLM to pick an LLM pays the
 * exact latency and cost a gateway exists to remove.
 *
 * The rules are written to be citable in the report:
 *  - Fast/cheap tier (A) handles the bulk: simple-shape questions, strong retrieval.
 *  - Capable tier (B) takes weak-retrieval (ambiguous) or long/multi-part
 *    questions, where extra reasoning is worth the extra cost. "Weak" is a
 *    band, not a point: below the refusal floor nothing routes (the gate
 *    fires in the route first), so the swap threshold sits *above* the floor.
 *  - The mock is never chosen by policy — it exists to fail on demand.
 *  - ROUTING_CHAIN (env boot default; runtime-editable via the Demo Lab when
 *    DEMO_CONTROLS=1) may reorder candidates purely to demo fallback
 *    (e.g. mock first, real backend second) without changing the rules.
 */

export type RouteContext = {
  capability: "chat" | "support-assistant";
  question: string;
  /** Normalized 0..1 retrieval confidence; undefined for plain chat. */
  retrievalConfidence?: number;
  /**
   * Eval/debug pin (e.g. A/B runs): force this backend first in the plan.
   * Not policy — a gateway-debug affordance so the eval harness can pin a
   * tier without redeploying two configs.
   */
  pinBackendId?: string;
};

export type Candidate = {
  adapter: ModelAdapter;
  /** Why this candidate is in the plan, in this position. */
  reason: string;
};

const REAL_TIERS = ["openrouter-tier-a", "openrouter-tier-b"] as const;

const COMPLEX_HINTS = [
  "because", "however", "difference", "compare", "explain", "why",
  "multiple", "steps", "detailed", "policy", "also",
];

export function questionComplexity(question: string): "simple" | "complex" {
  const long = question.length > 240;
  const hints = COMPLEX_HINTS.filter((h) => question.toLowerCase().includes(h)).length;
  const multiPart = (question.match(/\?/g)?.length ?? 0) > 1;
  return long || hints >= 2 || multiPart ? "complex" : "simple";
}

export function choosePrimary(ctx: RouteContext): string {
  const complexity = questionComplexity(ctx.question);
  if (
    ctx.capability === "support-assistant" &&
    (ctx.retrievalConfidence ?? 0) < config.assistant.tierBSwapBelowConfidence
  ) {
    return "openrouter-tier-b"; // weak (but above the refusal floor) retrieval → ambiguous match → spend the stronger tier
  }
  return complexity === "simple" ? "openrouter-tier-a" : "openrouter-tier-b";
}

export function primaryReason(ctx: RouteContext): string {
  const complexity = questionComplexity(ctx.question);
  if (ctx.capability !== "support-assistant") return `chat: ${complexity} question`;
  const conf = ctx.retrievalConfidence ?? 0;
  // "strong/weak" uses the same comparator as choosePrimary's tier-B swap, so
  // the label and the decision can never disagree.
  return `assistant: retrieval confidence ${conf.toFixed(2)} (${conf >= config.assistant.tierBSwapBelowConfidence ? "strong" : "weak"}), ${complexity} question`;
}

export function buildRoutePlan(ctx: RouteContext, byId: Map<string, ModelAdapter>): Candidate[] {
  if (ctx.pinBackendId && byId.has(ctx.pinBackendId)) {
    const pin = byId.get(ctx.pinBackendId)!;
    const pinned = [{ adapter: pin, reason: `pinned by request (eval A/B): ${primaryReason(ctx)}` }];
    return pinned.concat(
      buildRoutePlan({ ...ctx, pinBackendId: undefined }, byId).filter((c) => c.adapter.meta.id !== ctx.pinBackendId),
    );
  }

  const primary = choosePrimary(ctx);
  const plan: Candidate[] = [];

  const primaryAdapter = byId.get(primary);
  if (primaryAdapter) plan.push({ adapter: primaryAdapter, reason: primaryReason(ctx) });

  for (const id of REAL_TIERS) {
    const adapter = byId.get(id);
    if (!adapter || id === primary) continue;
    plan.push({ adapter, reason: `fallback candidate after ${primary} (cross-tier)` });
  }

  if (demoControls.routingChain()) {
    const order = demoControls.routingChain().split(",").map((s) => s.trim()).filter(Boolean);
    const picked = order
      .map((id) => byId.get(id))
      .filter((a): a is ModelAdapter => Boolean(a))
      .map((adapter, i) => ({
        adapter,
        reason: `demo override (ROUTING_CHAIN position ${i}): ${primaryReason(ctx)}`,
      }));
    const notPicked = plan.filter((c) => !order.includes(c.adapter.meta.id));
    return picked.concat(notPicked);
  }

  return plan;
}