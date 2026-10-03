/**
 * Shared SSE/usage client logic for the console.
 */

export type PlanStep = { backendId: string; action: string; reason: string };
export type RetrievedEntry = { id: number; question: string; answer: string; intent: string; category: string };
export type Metering = {
  model: string;
  tokens: { prompt: number; completion: number };
  latencyMs: number;
  estimatedCostUsd: number;
  costSource: string;
};

export type StreamHandlers = {
  onMeta: (meta: StreamMeta) => void;
  onDelta: (text: string) => void;
  onFinal: (final: StreamFinal) => void;
  onError: (code: string, message: string, details?: Record<string, unknown>) => void;
  onDone: () => void;
};

export type StreamMeta = {
  requestId?: string;
  backend?: { id: string; label: string; model: string };
  fallbackTriggered?: boolean;
  routingPlan?: PlanStep[];
  retrieval?: { entries: RetrievedEntry[]; confidence: number };
  intent?: { intent: string | null; confidence: number };
  refusal?: boolean;
  reason?: string;
};

export type StreamFinal = {
  refused?: boolean;
  message?: string;
  answer?: string;
  reasoning?: string;
  retrieval?: { entries: RetrievedEntry[]; confidence: number };
  intent?: { intent: string | null; confidence: number };
  metering?: Metering;
  quota?: { used: { requestCount: number; tokensTotal: number; day: string }; limits: { requestsPerDay: number; tokensPerDay: number } };
  ok?: boolean;
};

export type Body = { message: string; response: Response; ok: boolean };

/** POST an SSE endpoint and dispatch parsed events to handlers. */
export async function postStream(
  path: string,
  body: unknown,
  apiKey: string,
  h: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    // Non-stream failure (auth/quota/validation): gateway returns structured JSON.
    const data = await res.json().catch(() => ({ error: { code: "unknown", message: res.statusText } }));
    const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error;
    h.onError(err?.code ?? "unknown", err?.message ?? `HTTP ${res.status}`, err?.details);
    h.onDone();
    return;
  }

  const reader = res.body!.getReader();
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
      let type = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let json: Record<string, unknown>;
      try { json = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
      switch (type) {
        case "meta": h.onMeta(json as unknown as StreamMeta); break;
        case "delta": h.onDelta((json as { text?: string }).text ?? ""); break;
        case "final": h.onFinal(json as unknown as StreamFinal); h.onDone(); break;
        case "error": {
          const e = json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
          h.onError(e.error?.code ?? "unknown", e.error?.message ?? "stream error", e.error?.details);
          h.onDone();
          break;
        }
        default: break; // stream_end / comments
      }
      if (type === "final" || type === "error") return;
    }
  }
  h.onDone();
}

export type UsageResponse = {
  tenants: {
    id: number;
    name: string;
    today: { requests: number; tokens: number; costsUsd: number };
    quota: { requestsPerDay: number; tokensPerDay: number };
    remaining: { requests: number; tokens: number };
    totals: { requests: number; costUsd: number };
    byCapability: { capability: string; requests: number }[];
    byOutcome: { outcome: string; requests: number }[];
  }[];
  recentRoutingDecisions: {
    requestId: string;
    tenantId: number;
    capability: string;
    plan: PlanStep[];
    chosenBackendId: string | null;
    fallbackTriggered: boolean;
    createdAt: string;
  }[];
};

export async function fetchUsage(apiKey: string): Promise<UsageResponse> {
  const res = await fetch("/v1/usage", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`usage failed: HTTP ${res.status}`);
  return (await res.json()) as UsageResponse;
}