import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, KeyRound, MessageSquarePlus, Square, Sparkles, Trash2 } from "lucide-react";
import { deleteChatSession, fetchChatSessions, fetchSessionTimeline, postStream, type ChatSessionRow, type StreamFinal, type StreamMeta, type Turn } from "./api";
import { useKeys } from "./keys";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input, Textarea } from "./components/ui/input";
import { cn, usd } from "./lib/utils";
import { outcomeBadge } from "./lib/badges";
import { Bubble } from "./lib/chatui";

/**
 * Playground: session rail (Langfuse-style grouping) + chat pane + X-ray.
 * Gated on an issued API key (the product-team integration flow). Sessions
 * are grouping only — the assistant stays single-turn by design.
 */

const KEY_STORAGE = "playground.key";
const SESSION_STORAGE = "playground.sessionExternalId";

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
  return <SessionChat apiKey={pastedKey} onDisconnect={disconnect} />;
}

/** The issue → copy → paste gate (keys are one and irreplaceable). */
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
    const res = await fetch("/v1/console/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "playground" }) });
    setBusy(false);
    if (res.ok) {
      const data = (await res.json()) as { apiKey: string };
      onIssued(data.apiKey);
    } else {
      onIssued("");
    }
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
              You have an active key (name + mask on the API Keys page — the plaintext was shown once). Paste it here.
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
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

type Exchange =
  | { kind: "live"; meta: StreamMeta | null; final: StreamFinal | null; text: string; fault: Fault | null }
  | { kind: "turn"; turn: Turn };

function SessionChat({ apiKey, onDisconnect }: { apiKey: string; onDisconnect: () => void }): React.ReactElement {
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeExt, setActiveExt] = useState<string>(
    () => localStorage.getItem(SESSION_STORAGE) ?? crypto.randomUUID(),
  );
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [meta, setMeta] = useState<StreamMeta | null>(null);
  const [final, setFinal] = useState<StreamFinal | null>(null);
  const [fault, setFault] = useState<Fault | null>(null);
  const [streamText, setStreamText] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchChatSessions();
      setSessions(list.filter((s) => !s.deletedAt));
    } catch {
      /* session list is non-critical */
    }
  }, []);

  const loadTurns = useCallback(async (externalId: string) => {
    const row = (await fetchChatSessions().catch(() => null))?.find((s) => s.externalId === externalId);
    if (!row) {
      setExchanges([]);
      return;
    }
    const timeline = await fetchSessionTimeline(row.uid);
    setExchanges(timeline ? timeline.turns.map((turn) => ({ kind: "turn" as const, turn })) : []);
  }, []);

  useEffect(() => {
    void refresh();
    void loadTurns(activeExt);
    localStorage.setItem(SESSION_STORAGE, activeExt);
  }, [activeExt, refresh, loadTurns]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [exchanges.length, streamText]);

  async function newSession(): Promise<void> {
    setActiveExt(crypto.randomUUID());
    setMeta(null);
    setFinal(null);
    setFault(null);
    setStreamText("");
    await refresh();
  }

  async function removeSession(s: ChatSessionRow): Promise<void> {
    await deleteChatSession(s.uid);
    if (s.externalId === activeExt) await newSession();
    else await refresh();
  }

  async function send(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true);
    setFault(null);
    setMeta(null);
    setFinal(null);
    setStreamText("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await postStream("/v1/support-assistant", { message: input, sessionId: activeExt }, apiKey, {
        onMeta: setMeta,
        onDelta: (t) => setStreamText((s) => s + t),
        onFinal: (f) => {
          setFinal(f);
          void refresh();
          void loadTurns(activeExt);
        },
        onError: (code, message) => setFault({ code, message }),
        onDone: () => undefined,
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setFault({ code: "network", message: String(err) });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const liveAnswer = final?.refused ? final.message ?? "" : final?.answer ?? streamText;
  const showLiveExchange = busy || meta || final || fault;

  return (
    <div className="mx-auto grid max-w-7xl gap-5 pt-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_380px]">
      {/* session rail */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">sessions</p>
          <Button size="sm" variant="ghost" onClick={() => void newSession()} title="new session">
            <MessageSquarePlus className="size-4" />
          </Button>
        </div>
        <div className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto">
          {sessions.length === 0 && (
            <p className="px-1 text-xs text-muted-foreground">no sessions yet — your first message opens one</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.uid}
              className={cn(
                "group flex items-center gap-1 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors",
                s.externalId === activeExt ? "border-primary/50 bg-accent" : "border-transparent hover:bg-accent/60",
              )}
            >
              <button
                className="min-w-0 flex-1 text-start"
                onClick={() => setActiveExt(s.externalId)}
                title={s.title}
              >
                <p className="truncate font-medium">{s.title || "session"}</p>
                <p className="text-[10px] text-muted-foreground">
                  {s.turns} turns · {usd(s.spendUsd)}
                </p>
              </button>
              <button
                onClick={() => void removeSession(s)}
                title="delete (soft — history stays in observability)"
                className="opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* chat pane */}
      <div className="flex min-w-0 flex-col gap-4">
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
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={onDisconnect} className="text-muted-foreground">
                    disconnect key
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void newSession()} className="text-muted-foreground hidden sm:inline-flex">
                    <MessageSquarePlus className="size-3.5" /> new
                  </Button>
                </div>
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

        <div className="flex flex-col gap-3">
          {exchanges.map((x, i) =>
            x.kind === "turn" ? (
              <TwoBubbles key={i} q={x.turn.question ?? ""} a={x.turn.answer} error={x.turn.error} refused={x.turn.outcome === "refused"} />
            ) : null,
          )}
          {showLiveExchange && (
            <TwoBubbles
              q={input}
              a={final?.refused ? final.message ?? "" : (final?.answer ?? streamText) || null}
              error={fault?.message ?? null}
              refused={final?.refused === true}
              live={busy && !streamText}
            />
          )}
          {exchanges.length === 0 && !showLiveExchange && (
            <p className="py-8 text-center text-sm text-muted-foreground">start with one of these, or type your own</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          {EXAMPLES.map((ex) => (
            <Button key={ex} variant="outline" size="sm" className="rounded-full" onClick={() => setInput(ex)}>
              {ex}
            </Button>
          ))}
        </div>
      </div>

      {/* X-ray — live exchange only */}
      <div className="hidden min-w-0 flex-col gap-4 xl:flex">
        <Xray meta={meta} final={final} fault={fault} />
      </div>
    </div>
  );
}

function TwoBubbles({ q, a, error, refused, live }: { q: string; a: string | null; error: string | null; refused?: boolean; live?: boolean }): React.ReactElement {
  return (
    <>
      <Bubble role="user">{q}</Bubble>
      {error ? <Bubble role="assistant" tone="error">{error}</Bubble> : refused ? <Bubble role="assistant" tone="warning">{a}</Bubble> : <Bubble role="assistant" live={live}>{a}</Bubble>}
    </>
  );
}

export function Xray({ meta, final, fault }: { meta: StreamMeta | null; final: StreamFinal | null; fault: Fault | null }): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader><CardTitle>routing</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {fault && <p className="text-sm text-destructive">{fault.code}</p>}
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
          ) : !fault && <p className="text-sm text-muted-foreground">waiting for first request…</p>}
        </CardContent>
      </Card>

      <div className="grid gap-4">
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
        </div>

        <Card>
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