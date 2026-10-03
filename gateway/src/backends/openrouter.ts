import { config } from "../config.js";
import {
  estimateCost,
  type AdapterMeta,
  type ModelAdapter,
  type StreamEvent,
  type StreamRequest,
  type Usage,
} from "./types.js";

/**
 * OpenRouter adapter — the real-model path (brief: at least one real model
 * must serve real requests). Speaks the OpenAI chat-completions dialect with
 * `stream: true` so a single adapter serves both tiers: the model ID is env-
 * pinned per backend (TIER_A_MODEL / TIER_B_MODEL).
 *
 * Timeout discipline is inherited from production experience: a stalled
 * upstream aborts inside the adapter and surfaces as a throw the router can
 * fall back on — it never hangs past the proxy's budget.
 */

type OpenAiChunk = {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
};

export function makeOpenRouterAdapter(meta: AdapterMeta): ModelAdapter {
  return {
    meta,
    async *stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, unknown> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), meta.timeoutMs);
      try {
        const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.openrouter.apiKey}`,
            "HTTP-Referer": process.env.APP_URL?.trim() || "http://localhost",
            "X-Title": "Mini Inference Router",
          },
          body: JSON.stringify({
            model: meta.modelId,
            messages: req.messages,
            max_tokens: req.maxTokens,
            temperature: req.temperature ?? 0.3,
            stream: true,
            // Ask the final chunk to carry usage so metering is per-request real data.
            stream_options: { include_usage: true },
            ...(req.responseFormatJson ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(`${meta.id} upstream ${res.status}: ${text.slice(0, 200)}`);
        }

        let usage: Usage = { promptTokens: 0, completionTokens: 0 };
        let firstByte = true;
        for await (const chunk of sseChunks(res.body)) {
          if (firstByte) {
            firstByte = false;
            clearTimeout(timer); // produced output → the "too slow" window is passed
          }
          if (chunk === "[DONE]") break;
          let parsed: OpenAiChunk;
          try {
            parsed = JSON.parse(chunk) as OpenAiChunk;
          } catch {
            continue; // tolerate keep-alive noise between frames
          }
          if (parsed.error) throw new Error(`${meta.id} upstream error: ${parsed.error.message ?? "unknown"}`);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield { type: "delta", text: delta };
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens ?? usage.promptTokens,
              completionTokens: parsed.usage.completion_tokens ?? usage.completionTokens,
              costUsd: parsed.usage.cost,
            };
          }
        }
        if (!usage.promptTokens && !usage.completionTokens) {
          usage.promptTokens = approxTokens(req.messages.map((m) => m.content).join("\n"));
        }
        yield { type: "done", usage };
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || controller.signal.aborted)) {
          throw new Error(`${meta.id} timed out after ${meta.timeoutMs}ms (no usable output)`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Parse `data: {...}\n\n` SSE frames from a fetch body stream. */
async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (data) yield data;
      }
    }
  }
  const tail = decoder.decode();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

/** ~4 chars/token fallback so metering stays defined even without usage. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export { estimateCost };