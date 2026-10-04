import {
  estimateCost,
  type AdapterMeta,
  type ModelAdapter,
  type StreamEvent,
  type StreamRequest,
} from "./types.js";
import { demoControls } from "../lib/demoControls.js";

/**
 * Mock backend (DECISIONS.md D4): scripted adapter with configurable latency
 * and failure — the brief's own suggestion for demonstrating fallback without
 * burning real quota. Env-configurable per RUN (MOCK_FAILURE_MODE), and — when
 * the Demo Lab flag is on — runtime-editable, since the script reads
 * demoControls (which boots from the env values) each call.
 */

const REPLY = "This is the mock backend answering: the real model path is up and this text proves streaming, metering, and fallback plumbing end to end. ";

export function makeMockAdapter(meta: AdapterMeta): ModelAdapter {
  return {
    meta,
    async *stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, unknown> {
      const cfg = demoControls.mock();

      await setTimeoutOrAbort(meta.timeoutMs, cfg.firstByteDelayMs);

      // Two failure levers: failureMode=fail → deterministic failure
      // (video demo, reproducible); failureRate=p → probabilistic
      // (exercises the router's fallback on real variation). Both can be 0.
      if (cfg.failureMode === "fail" || Math.random() < cfg.failureRate) {
        throw new Error(`${meta.id} scripted failure (mode=${cfg.failureMode})`);
      }

      if (cfg.failureMode === "hang") {
        // Never yields — the adapter-level timeout must abort this.
        await sleep(999_999);
        return; // unreachable, satisfies the generator contract
      }

      if (cfg.failureMode === "midstream") {
        // Start answering, then die mid-answer — exercises the router's
        // "fallback stops at first byte" boundary from inside a stream.
        const chunks = 2;
        for (let i = 0; i < chunks; i++) {
          await setTimeoutOrAbort(meta.timeoutMs, cfg.chunkDelayMs);
          yield { type: "delta", text: REPLY.slice(i * 24, i * 24 + 24) };
        }
        await setTimeoutOrAbort(meta.timeoutMs, cfg.chunkDelayMs);
        throw new Error(`${meta.id} scripted mid-stream failure`);
      }

      if (cfg.failureMode === "short") {
        // A technically-successful but unusable answer (<15 chars) — drives the
        // route layer's unusable-output refusal without a failure event.
        await setTimeoutOrAbort(meta.timeoutMs, cfg.chunkDelayMs);
        yield { type: "delta", text: "ok" };
        yield {
          type: "done",
          usage: {
            promptTokens: Math.ceil((req.messages.map((m) => m.content).join("\n").length || 1) / 4),
            completionTokens: 1,
          },
        };
        return;
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