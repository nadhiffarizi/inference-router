import type { AdapterMeta, ModelAdapter, StreamEvent, StreamRequest } from "../backends/types.js";
import type { PlanStep } from "../lib/metering.js";
import type { Candidate } from "./rules.js";

/**
 * Dispatch: walk the candidate plan, take the first backend that produces
 * output, fall back on error/timeout. The decision trail (plan steps) is
 * returned so the route layer can persist and expose it.
 *
 * Boundary honoured here (declared in DECISIONS.md D5/D10): fallback applies
 * until the first content delta. Once a backend has started streaming to the
 * client,
 * a mid-stream failure is surfaced as an error event — re-routing mid-answer
 * would duplicate or splice content, i.e. be correct-looking and wrong.
 */

export type DispatchOutcome = {
  /** The decision trail, owned by dispatch: one step per candidate tried. */
  steps: PlanStep[];
} & (
  | {
      ok: true;
      stream: AsyncGenerator<StreamEvent, void, unknown>;
      chosen: ModelAdapter;
      fallbackTriggered: boolean;
    }
  | {
      ok: false;
      /** No candidate produced output; error carries the last failure's cause. */
      lastError: string;
    }
);

export async function openWithFallback(plan: Candidate[], streamReq: StreamRequest): Promise<DispatchOutcome> {
  const steps: PlanStep[] = [];
  let lastError = "no candidate produced output";

  for (const cand of plan) {
    const iter = cand.adapter.stream(streamReq);
    try {
      // Router-level guard, independent of adapter discipline: every chunk
      // must arrive inside the adapter's timeout budget, including the first
      // ("too slow → fallback" in the brief). learned the hard way: a
      // generator awaiting an internal sleep ignores the fetch AbortController.
      // Consume pre-delta events until the first piece of content. Fallback
      // applies until the first DELTA, not the first event: adapters end with
      // a done event even after zero deltas, so a success-shaped empty stream
      // must fall through to the next candidate — marking it served here
      // burned the whole plan and left the caller a refusal while tier B had
      // the answer.
      const preDelta: StreamEvent[] = [];
      let firstDelta: StreamEvent | undefined;
      while (!firstDelta) {
        const r = await nextWithTimeout(iter, cand.adapter.meta.timeoutMs, cand.adapter.meta.id);
        if (r.done) break;
        if (r.value.type === "delta") {
          firstDelta = r.value;
          break;
        }
        preDelta.push(r.value);
      }
      if (!firstDelta) {
        steps.push({ backendId: cand.adapter.meta.id, action: "abandoned", reason: "stream completed without output" });
        lastError = `${cand.adapter.meta.id}: empty stream`;
        continue;
      }
      // Any attempt before this one failed or was abandoned — the caller was
      // not the plan's head, i.e. fallback fired either way. (An empty stream
      // is a fallback too; this line only counting "failed" is what made a
      // fallback trace read "fallback idle" in the X-ray.)
      const fallbackTriggered = steps.length > 0;
      steps.push({ backendId: cand.adapter.meta.id, action: "served", reason: cand.reason });
      return {
        ok: true,
        chosen: cand.adapter,
        fallbackTriggered,
        stream: guardedStream(iter, firstDelta, preDelta, cand.adapter.meta),
        steps: steps.concat(notReachedSteps(plan, steps.length, cand.adapter.meta.id)),
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      steps.push({ backendId: cand.adapter.meta.id, action: "failed", reason: lastError });
      await iter.return?.().catch(() => undefined); // finalize the abandoned generator
    }
  }
  return { ok: false, lastError, steps };
}

/**
 * The plan tail the win made unreachable, recorded as steps of its own so the
 * caller sees every planned backend — which one answered, which was tried and
 * failed, and which was never called at all.
 */
function notReachedSteps(plan: Candidate[], attempts: number, servedBy: string): PlanStep[] {
  return plan.slice(attempts).map((cand) => ({
    backendId: cand.adapter.meta.id,
    action: "skipped",
    reason: `not reached — ${servedBy} answered first`,
  }));
}

/** Race one iterator step against the timeout; also finalizes on loss. */
async function nextWithTimeout(
  iter: AsyncGenerator<StreamEvent, void, unknown>,
  timeoutMs: number,
  backendId: string,
): Promise<IteratorResult<StreamEvent, void>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${backendId} stalled ${timeoutMs}ms between chunks (router timeout)`)), timeoutMs);
  });
  try {
    return await Promise.race([iter.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The served stream keeps the per-chunk guard: a backend that goes silent
 * mid-answer is failed as an error event by the route layer, not hung.
 */
async function* guardedStream(
  iter: AsyncGenerator<StreamEvent, void, unknown>,
  firstDelta: StreamEvent,
  preDelta: StreamEvent[],
  meta: AdapterMeta,
): AsyncGenerator<StreamEvent, void, unknown> {
  // Re-emit events that arrived before the first delta (usage frames, today
  // none — but dropping adapter events silently would strand usage metering).
  for (const e of preDelta) yield e;
  yield firstDelta;
  if (meta.tier === "mock") { // scripted mock delays are part of its contract
    yield* iter;
    return;
  }
  while (true) {
    const r = await nextWithTimeout(iter, meta.timeoutMs, meta.id);
    if (r.done) return;
    yield r.value;
  }
}

export function adapterRegistry(adapters: ModelAdapter[]): Map<string, ModelAdapter> {
  return new Map(adapters.map((a) => [a.meta.id, a]));
}