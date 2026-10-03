import { useRef, useState } from "react";
import { postStream, type StreamFinal, type StreamMeta } from "./api";

/**
 * The playground: chat on the left, the X-ray panel on the right. Every event
 * the gateway emits is rendered — routing (which backend, why, fallback),
 * retrieval, intent, tokens/latency/cost — so the demo shows auth, routing,
 * metering working without reading a log.
 */

type Turn =
  | { kind: "pending" }
  | { kind: "answer"; text: string }
  | { kind: "refusal"; text: string; why?: string }
  | { kind: "error"; code: string; message: string };

export function Playground({ apiKey }: { apiKey: string }): React.ReactElement {
  const [turn, setTurn] = useState<Turn | null>(null);
  const [meta, setMeta] = useState<StreamMeta | null>(null);
  const [final, setFinal] = useState<StreamFinal | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [streamText, setStreamText] = useState("");

  async function send(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true);
    setTurn(null);
    setMeta(null);
    setFinal(null);
    setStreamText("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await postStream(
        "/v1/support-assistant",
        { message: input },
        apiKey,
        {
          onMeta: (m) => setMeta(m),
          onDelta: (t) => setStreamText((s) => s + t),
          onFinal: (f) => setFinal(f),
          onError: (code, message) => setTurn({ kind: "error", code, message }),
          onDone: () => undefined,
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setTurn({ kind: "error", code: "network", message: String(err) });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const answer = final?.refused ? final.message ?? "" : final?.answer ?? streamText;

  return (
    <div className="playground">
      <div className="chat">
        <form onSubmit={send}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a support question…"
            rows={3}
          />
          <div className="row">
            <button type="submit" disabled={busy}>
              {busy ? "streaming…" : "Ask"}
            </button>
            {busy && (
              <button type="button" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            )}
          </div>
        </form>

        {turn?.kind === "error" && (
          <div className="card error">
            <b>{turn.code}</b> — {turn.message}
          </div>
        )}
        {meta && (
          <div className="card">
            <div className="card-title">answer {meta.requestId && <code>{meta.requestId.slice(0, 8)}</code>}</div>
            <p className="answer">{busy ? streamText || "…" : answer}</p>
            {final?.refused && <p className="why">refused: {final.reasoning}</p>}
          </div>
        )}

        <div className="examples">
          <button onClick={() => setInput("how do I cancel my order?")}>on-KB: cancel order</button>
          <button onClick={() => setInput("what payment methods do you accept?")}>on-KB: payment methods</button>
          <button onClick={() => setInput("what is the meaning of life?")}>off-KB: refusal</button>
        </div>
      </div>

      <div className="xray">
        <Panel title="routing">
          {meta ? (
            <ul>
              <li>
                backend: <b>{meta.backend?.id}</b> ({meta.backend?.model})
              </li>
              <li>fallback: {meta.fallbackTriggered ? "FIRED" : "no"}</li>
              <li>
                plan: <ol>{meta.routingPlan?.map((s, i) => <li key={i}>{s.backendId} → {s.action} ({s.reason})</li>)} </ol>
              </li>
            </ul>
          ) : (
            <Muted>waiting…</Muted>
          )}
        </Panel>
        <Panel title="retrieval">
          {meta?.retrieval ? (
            <>
              <p>confidence: {meta.retrieval.confidence.toFixed(3)}</p>
              <ul>
                {meta.retrieval.entries.map((e) => (
                  <li key={e.id}>
                    <code>{e.intent}</code> — {e.question.slice(0, 70)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Muted>{meta?.refusal ? "refused before retrieval display" : "waiting…"}</Muted>
          )}
        </Panel>
        <Panel title="intent">
          {meta?.intent ? (
            <p>
              <b>{meta.intent.intent ?? "none"}</b> (confidence {meta.intent.confidence.toFixed(2)})
            </p>
          ) : (
            <Muted>waiting…</Muted>
          )}
        </Panel>
        <Panel title="metering">
          {final?.metering ? (
            <ul>
              <li>model: {final.metering.model}</li>
              <li>tokens: {final.metering.tokens.prompt} in / {final.metering.tokens.completion} out</li>
              <li>latency: {final.metering.latencyMs} ms</li>
              <li>cost: ${final.metering.estimatedCostUsd.toFixed(6)} ({final.metering.costSource})</li>
            </ul>
          ) : (
            <Muted>waiting…</Muted>
          )}
        </Panel>
        <Panel title="quota">
          {final?.quota ? (
            <p>
              {final.quota.used.requestCount}/{final.quota.limits.requestsPerDay} req/day ·{" "}
              {final.quota.used.tokensTotal}/{final.quota.limits.tokensPerDay} tokens
            </p>
          ) : (
            <Muted>waiting…</Muted>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="card">
      <div className="card-title">{title}</div>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="muted">{children}</p>;
}