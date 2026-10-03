import { useRef, useState } from "react";
import { ArrowUp, KeyRound, Square, Sparkles } from "lucide-react";
import { postStream, type StreamFinal, type StreamMeta } from "./api";
import { useKeys } from "./keys";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input, Textarea } from "./components/ui/input";
import { cn, usd } from "./lib/utils";
import { outcomeBadge } from "./lib/badges";

/**
 * Playground: chat on the left, the X-ray on the right. Gated on an issued
 * API key (the product-team integration flow): issue in the keys screen →
 * paste here. The pasted key persists locally so reloads don't re-paste.
 */

const KEY_STORAGE = "playground.key";

type Fault = { code: string; message: string };

const EXAMPLES = ["how do I cancel my order?", "what payment methods do you accept?", "what is the meaning of life?"];

export function Playground(): React.ReactElement {
  const [pastedKey, setPastedKey] = useState<string | null>(() => localStorage.getItem(KEY_STORAGE));
  const keys = useKeys();

  function connect(key: string): void {
    const trimmed = key.trim();
    if (!trimmed) return;
    localStorage.setItem(KEY_STORAGE, trimmed);
    setPastedKey(trimmed);
  }

  function disconnect(): void {
    localStorage.removeItem(KEY_STORAGE);
    setPastedKey(null);
  }

  if (!pastedKey) {
    return <ConnectGate keysPresent={keys.keys.length > 0} onIssued={connect} onConnect={connect} error={keys.error} />;
  }
  return <Chat apiKey={pastedKey} tenant={"demo"} onDisconnect={disconnect} />;
}

/** The issue → copy → paste gate, exactly per the ops spec. */
function ConnectGate({
  keysPresent,
  onIssued,
  onConnect,
  error,
}: {
  keysPresent: boolean;
  onIssued: (key: string) => void;
  onConnect: (key: string) => void;
  error: string | null;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState("");

  async function issueAndConnect(): Promise<void> {
    setBusy(true);
    const issued = await issueKeyOnPlayground();
    setBusy(false);
    if (issued) onIssued(issued);
  }

  return (
    <div className="mx-auto max-w-xl pt-5">
      <Card>
        <CardHeader><CardTitle>connect the playground</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {!keysPresent && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              Your account has no API key yet — the playground calls the gateway with a key, like a product
              team's integration would.
              <Button className="mt-3 w-full" size="sm" onClick={() => void issueAndConnect()} disabled={busy}>
                <KeyRound className="size-3.5" /> {busy ? "issuing…" : "Issue an API key and connect"}
              </Button>
            </div>
          )}
          {keysPresent && (
            <p className="text-sm text-muted-foreground">
              You have an active key (masked again on the API Keys page — plaintext is shown once). Paste it
              here, or issue a fresh one.
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onConnect(value);
            }}
            className="flex gap-2"
          >
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk_… paste your API key" className="font-mono" />
            <Button type="submit" size="sm" disabled={!value.trim()}>Connect</Button>
          </form>
          <Button variant="outline" size="sm" onClick={() => void issueAndConnect()} disabled={busy}>
            <KeyRound className="size-3" /> issue a fresh key
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

async function issueKeyOnPlayground(): Promise<string | null> {
  const res = await fetch("/v1/console/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "playground" }) });
  if (!res.ok) return null;
  const data = (await res.json()) as { apiKey: string };
  return data.apiKey;
}

function Chat({ apiKey, onDisconnect }: { apiKey: string; tenant?: string; onDisconnect: () => void }): React.ReactElement {
  const [turn, setTurn] = useState<Fault | null>(null);
  const [meta, setMeta] = useState<StreamMeta | null>(null);
  const [final, setFinal] = useState<StreamFinal | null>(null);
  const [streamText, setStreamText] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
      await postStream("/v1/support-assistant", { message: input }, apiKey, {
        onMeta: setMeta,
        onDelta: (t) => setStreamText((s) => s + t),
        onFinal: setFinal,
        onError: (code, message) => setTurn({ code, message }),
        onDone: () => undefined,
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setTurn({ code: "network", message: String(err) });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const answer = final?.refused ? final.message ?? "" : final?.answer ?? streamText;

  return (
    <div className="mx-auto grid max-w-6xl gap-5 pt-5 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Card>
          <CardContent className="p-4">
            <form onSubmit={send}>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask a support question…"
                rows={3}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e);
                }}
              />
              <div className="mt-3 flex items-center justify-between">
                <Button type="button" variant="ghost" size="sm" onClick={onDisconnect} className="text-muted-foreground">
                  disconnect key
                </Button>
                {busy ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => abortRef.current?.abort()}>
                    <Square className="size-3.5" /> Stop
                  </Button>
                ) : (
                  <Button type="submit" size="sm" disabled={!input.trim()}>
                    <ArrowUp className="size-3.5" /> Ask
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        {turn && (
          <Card className="border-destructive/40">
            <CardContent className="p-4">
              <Badge variant="destructive">{turn.code}</Badge>
              <p className="mt-2 text-sm">{turn.message}</p>
            </CardContent>
          </Card>
        )}

        {meta && !turn && (
          <Card>
            <CardHeader><CardTitle>answer</CardTitle></CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{busy ? streamText || "…" : answer}</p>
              {final?.refused && (
                <p className="mt-3 text-xs text-muted-foreground">
                  <Badge variant="warning" className="mr-2">refused</Badge>
                  {final.reasoning}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          {EXAMPLES.map((ex) => (
            <Button key={ex} variant="outline" size="sm" className="rounded-full" onClick={() => setInput(ex)}>
              {ex}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader><CardTitle>routing</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {meta ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="info">{meta.backend?.id}</Badge>
                  <span className="font-mono text-xs text-muted-foreground">{meta.backend?.model}</span>
                  {meta.fallbackTriggered ? <Badge variant="warning">fallback fired</Badge> : <Badge variant="secondary">fallback idle</Badge>}
                </div>
                <ol className="mt-1 space-y-1.5">
                  {meta.routingPlan?.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <Badge variant={outcomeBadge(s.action)}>{s.action}</Badge>
                      <span className="font-mono">{s.backendId}</span>
                      <span className="text-muted-foreground">{s.reason}</span>
                    </li>
                  ))}
                </ol>
              </>
            ) : <p className="text-sm text-muted-foreground">waiting for first request…</p>}
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>retrieval</CardTitle></CardHeader>
            <CardContent>
              {meta?.retrieval ? (
                <div className="space-y-2">
                  <p className="flex items-baseline gap-1">
                    <span className="text-2xl font-semibold">{meta.retrieval.confidence.toFixed(2)}</span>
                    <span className="text-xs text-muted-foreground">confidence</span>
                  </p>
                  <ul className="space-y-1.5">
                    {meta.retrieval.entries.map((e) => (
                      <li key={e.id} className="truncate text-xs text-muted-foreground">
                        <Badge variant="outline" className="mr-1.5 text-[10px]">{e.intent}</Badge>
                        {e.question.slice(0, 48)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <p className="text-sm text-muted-foreground">waiting…</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>intent</CardTitle></CardHeader>
            <CardContent>
              {meta?.intent ? (
                <div className="space-y-1">
                  <span className={cn("text-lg font-semibold", !meta.intent.intent && "text-muted-foreground")}>
                    {meta.intent.intent ?? "none"}
                  </span>
                  <p className="text-xs text-muted-foreground">confidence {meta.intent.confidence.toFixed(2)}</p>
                </div>
              ) : <p className="text-sm text-muted-foreground">waiting…</p>}
            </CardContent>
          </Card>

          <Card className="sm:col-span-2">
            <CardHeader><CardTitle>metering</CardTitle></CardHeader>
            <CardContent>
              {final?.metering ? (
                <div className="grid grid-cols-4 gap-3">
                  <Metric label="model" value={final.metering.model.replace(/^google\/|^anthropic\//, "")} />
                  <Metric label="latency" value={`${final.metering.latencyMs} ms`} />
                  <Metric label="tokens" value={`${final.metering.tokens.prompt} + ${final.metering.tokens.completion}`} />
                  <Metric label="cost" value={usd(final.metering.estimatedCostUsd)} hint={final.metering.costSource} />
                </div>
              ) : <p className="text-sm text-muted-foreground">waiting…</p>}
              {final?.quota && (
                <p className="mt-3 text-xs text-muted-foreground">
                  quota today: {final.quota.used.requestCount}/{final.quota.limits.requestsPerDay} requests · spend $
                  {Number(final.quota.used.usdSpend ?? 0).toFixed(4)} of $
                  {(final.quota.limits as { budgetUsdPerDay?: number }).budgetUsdPerDay?.toFixed(2) ?? "—"}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }): React.ReactElement {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono text-sm font-semibold">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}