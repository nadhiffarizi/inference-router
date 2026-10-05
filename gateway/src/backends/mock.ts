import { config } from "../config.js";
import {
  estimateCost,
  type AdapterMeta,
  type ModelAdapter,
  type StreamEvent,
  type StreamRequest,
} from "./types.js";

/**
 * Mock backend (DECISIONS.md D4): scripted adapter with configurable latency
 * and failure — the brief's own suggestion for demonstrating fallback without
 * burning real quota. Env-configurable per RUN, which is exactly what a demo
 * needs: set MOCK_FAILURE_MODE=hang for the video and the router's timeout →
 * fallback path fires deterministically.
 */

const REPLY = "This is the mock backend answering: the real model path is up and this text proves streaming, metering, and fallback plumbing end to end. ";

export function makeMockAdapter(meta: AdapterMeta): ModelAdapter {
  const cfg = config.backends.mock;
  return {
    meta,
    async *stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, unknown> {
      await setTimeoutOrAbort(meta.timeoutMs, cfg.firstByteDelayMs);

      // Two failure levers: MOCK_FAILURE_MODE=fail → deterministic failure
      // (video demo, reproducible); MOCK_FAILURE_RATE=p → probabilistic
      // (exercises the router's fallback on real variation). Both can be 0.
      if (cfg.failureMode === "fail" || Math.random() < cfg.failureRate) {
        throw new Error(`${meta.id} scripted failure (mode=${cfg.failureMode})`);
      }

      if (cfg.failureMode === "hang") {
        // Never yields — and never settles on its own, ON PURPOSE. The adapter
        // contract (same as openrouter.ts's TTFB abort) is to unwind at the
        // timeout budget and throw, so the router can catch and finalize the
        // generator. A bare non-abortable sleep() here is poison: dispatch's
        // router guard fires its 6s rejection, but iter.return() can't deliver
        // a return completion to a generator suspended on an await that never
        // settles — verified live, the whole SSE response hung past 125s.
        await new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${meta.id} hung (scripted) — past its ${meta.timeoutMs}ms TTFB budget`)), meta.timeoutMs),
        );
        return; // unreachable, satisfies the generator contract
      }

      const words = req.messages.at(-1)?.content ?? REPLY;
      const chunks = 6;
      for (let i = 0; i < chunks; i++) {
        await setTimeoutOrAbort(meta.timeoutMs, cfg.chunkDelayMs);
        yield { type: "delta", text: REPLY.slice((i % REPLY.length), (i % REPLY.length) + 24) + (i === chunks - 1 ? ` (echo: ${words.slice(0, 40)})` : "") };
      }
      yield {
        type: "done",
        usage: {
          promptTokens: Math.ceil((req.messages.map((m) => m.content).join("\n").length || 1) / 4),
          completionTokens: Math.ceil(REPLY.length / 4),
        },
      };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setTimeoutOrAbort(timeoutMs: number, delayMs: number): Promise<void> {
  // Cap scripted delays below the adapter timeout so a "slow mock" tests the
  // router's timeout→fallback path rather than a hang.
  return sleep(Math.min(delayMs, timeoutMs + 1_000));
}

export { estimateCost };