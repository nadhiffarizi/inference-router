/**
 * ModelAdapter: the seam between the gateway and any OpenAI-compatible
 * provider (DECISIONS.md D4). The gateway's routing/quota/metering never
 * learns about OpenRouter specifically — swapping providers is a new adapter
 * implementation, not a rewrite. The mock backend is an adapter too.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported cost (OpenRouter supplies it); undefined = estimate only. */
  costUsd?: number;
};

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage: Usage };

export type StreamRequest = {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  responseFormatJson?: boolean;
};

export type AdapterMeta = {
  id: string;
  label: string;
  modelId: string;
  tier: "a" | "b" | "mock";
  timeoutMs: number;
  pricePerMTokens: { input: number; output: number };
};

export interface ModelAdapter {
  readonly meta: AdapterMeta;
  /** Streaming call. Throws on unreachable/upstream error/timeout; the router catches and falls back. */
  stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, unknown>;
}

/** Cost fallback estimate (per-token price × tokens) when provider cost is absent. */
export function estimateCost(price: { input: number; output: number } | undefined, usage: Usage): number {
  if (!price) return 0;
  return (usage.promptTokens / 1_000_000) * price.input + (usage.completionTokens / 1_000_000) * price.output;
}