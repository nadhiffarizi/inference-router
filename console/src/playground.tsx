import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, KeyRound, MessageSquarePlus, MessageSquareText, Square, Sparkles, Trash2 } from "lucide-react";
import { deleteChatSession, fetchChatSessions, fetchSessionTimeline, postStream, type ChatSessionRow, type StreamFinal, type StreamMeta, type Turn } from "./api";
import { useKeys } from "./keys";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input, Textarea } from "./components/ui/input";
import { cn, usd } from "./lib/utils";
import { outcomeBadge } from "./lib/badges";
import { Bubble } from "./lib/chatui";
import { TraceDialog, type TracePayload } from "./components/trace-dialog";

/**
 * Playground: session rail (Langfuse-style grouping) + chat pane + X-ray.
 * Gated on an issued API key (the product-team integration flow). Sessions
 * are grouping only — the assistant stays single-turn by design.
 */

const KEY_STORAGE = "playground.key";
const SESSION_STORAGE = "playground.sessionExternalId";

type Fault = { code: string; message: string };

const EXAMPLES = ["how do I cancel my order?", "what payment methods do you accept?", "what is the meaning of life?"];

export type Capability = "assistant" | "chat";

export function Playground(): React.ReactElement {
  const [pastedKey, setPastedKey] = useState<string | null>(() => localStorage.getItem(KEY_STORAGE));
  const [capability, setCapability] = useState<Capability>(
    () => (localStorage.getItem("playground.capability") as Capability) ?? "assistant",
  );
  const keys = useKeys();

  function switchCapability(c: Capability): void {
    setCapability(c);
    localStorage.setItem("playground.capability", c);
  }

  function connect(key: string): void {
    const trimmed = key.trim();
    if (!trimmed) return;
    localStorage.setItem(KEY_STORAGE, trimmed);
    setPastedKey(trimmed);
  }

  if (!pastedKey) {
    return <ConnectGate keysPresent={keys.keys.length > 0} onIssued={connect} onConnect={connect} error={keys.error} />;
  }
  return <SessionChat apiKey={pastedKey} capability={capability} onCapability={switchCapability} />;
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

/**
 * X-ray state rebuilt from a stored turn's trace (routing_decisions + the
 * request row) so re-entering a session replays its last turn's X-ray
 * instead of resetting to "waiting…". Not everything survives: intent
 * confidence isn't persisted, and quota is a live daily snapshot — those stay
 * unknown/null on restore.
 */
type RestoredXray = { meta: StreamMeta | null; final: StreamFinal | null; fault: Fault | null };

function restoredXray(t: Turn): RestoredXray {
  return {
    meta: {
      requestId: t.id,
      backend: { id: t.backendId, label: t.backendId, model: t.modelId },
      fallbackTriggered: t.fallbackTriggered,
      routingPlan: t.plan,
      retrieval: t.retrieval ? { entries: t.retrieval, confidence: t.retrievalConfidence ?? 0 } : undefined,
      intent: { intent: t.intent, confidence: null },
    },
    final: t.outcome === "ok" ? {
      metering: {
        model: t.modelId,
        tokens: { prompt: t.promptTokens, completion: t.completionTokens },
        latencyMs: t.latencyMs,
        estimatedCostUsd: t.costUsd,
        costSource: "", // not persisted per turn
      },
    } : null,
    fault: t.outcome === "failed" || t.outcome === "quota_denied" ? { code: t.outcome, message: t.error ?? t.outcome } : null,
  };
}

function SessionChat({
  apiKey, capability, onCapability,
}: { apiKey: string; capability: Capability; onCapability: (c: Capability) => void }): React.ReactElement {
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeExt, setActiveExt] = useState<string>(
    () => localStorage.getItem(SESSION_STORAGE) ?? crypto.randomUUID(),
  );
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [meta, setMeta] = useState<StreamMeta | null>(null);
  const [final, setFinal] = useState<StreamFinal | null>(null);
  const [fault, setFault] = useState<Fault | null>(null);
  /** X-ray replayed from the session's last stored turn (live state wins once a stream runs). */
  const [restored, setRestored] = useState<RestoredXray | null>(null);
  const [streamText, setStreamText] = useState("");
  /** true between the stream's final event and that turn landing in the timeline — the window the live bubble must bridge alone. */
  const [pendingFinal, setPendingFinal] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  /** Latest requested session for loadTurns — stales out slow list/timeline responses. */
  const turnsReqRef = useRef<string | null>(null);
  const [openTrace, setOpenTrace] = useState<TracePayload | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchChatSessions();
      setSessions(list.filter((s) => !s.deletedAt));
    } catch {
      /* session list is non-critical */
    }
  }, []);

  const loadTurns = useCallback(async (externalId: string) => {
    turnsReqRef.current = externalId;
    const list = await fetchChatSessions().catch(() => null);
    if (turnsReqRef.current !== externalId) return; // a newer session took over mid-flight
    if (!list) return; // transient fetch failure — leave the visible transcript alone
    const row = list.find((s) => s.externalId === externalId);
    if (!row) {
      setExchanges([]); // this session genuinely has no history yet
      return;
    }
    const timeline = await fetchSessionTimeline(row.uid);
    if (turnsReqRef.current !== externalId) return; // same, across the second await
    if (!timeline) return; // transient fetch failure — leave the visible transcript alone
    setExchanges(timeline.turns.map((turn) => ({ kind: "turn" as const, turn })));
    // X-ray replays the session's last turn; an empty session resets to "waiting…"
    const last = timeline.turns[timeline.turns.length - 1];
    setRestored(last ? restoredXray(last) : null);
  }, []);

  useEffect(() => {
    // switching sessions (rail click or "new session") drops an in-flight
    // answer — otherwise its onFinal would paint the old session's turn here
    abortRef.current?.abort();
    abortRef.current = null;
    void refresh();
    void loadTurns(activeExt);
    localStorage.setItem(SESSION_STORAGE, activeExt);
  }, [activeExt, refresh, loadTurns]);

  useEffect(() => {
    // instant while tokens are streaming (repeating smooth scroll fights itself),
    // smooth for a whole new exchange landing
    chatBottomRef.current?.scrollIntoView({ behavior: streamText ? "instant" : "smooth", block: "end" });
  }, [exchanges.length, streamText, fault, final]);

  async function newSession(): Promise<void> {
    setActiveExt(crypto.randomUUID());
    setMeta(null);
    setRestored(null);
    setFinal(null);
    setFault(null);
    setStreamText("");
    setInput("");
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
    setInput(""); // clear immediately — the message lives in the stream now
    setBusy(true);
    setFault(null);
    setRestored(null); // a fresh exchange resets the X-ray (same as meta/final below)
    setMeta(null);
    setFinal(null);
    setStreamText("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await postStream(
        capability === "chat" ? "/v1/chat" : "/v1/support-assistant",
        { message: input, sessionId: activeExt, ...(capability === "chat" ? { maxTokens: 500 } : {}) },
        apiKey,
        {
          onMeta: setMeta,
          onDelta: (t) => setStreamText((s) => s + t),
          onFinal: (f) => {
            setFinal(f);
            setPendingFinal(true);
            void refresh();
            void loadTurns(activeExt).then(() => setPendingFinal(false));
          },
          onError: (code, message) => setFault({ code, message }),
          onDone: () => undefined,
        },
        controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setFault({ code: "network", message: String(err) });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const liveAnswer = final?.refused ? final.message ?? "" : final?.answer ?? streamText;
  // once the persisted turn arrives, the timeline bubble replaces the live one
  // (final alone would render the same exchange twice)
  const showLiveExchange = busy || pendingFinal || fault;

  return (
    <div className="mx-auto flex flex-col gap-5 pt-5 lg:h-[calc(100svh-8.5rem)] lg:flex-row lg:gap-0">
      {/* session rail — its own pane, divider on the right from lg up */}
      <aside className="flex w-full shrink-0 flex-col gap-2 pb-4 lg:h-full lg:min-h-0 lg:w-52 lg:border-r lg:border-border lg:pr-5 xl:w-56">
        <div className="flex shrink-0 items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">sessions</p>
          <Button size="sm" variant="ghost" onClick={() => void newSession()} title="new session">
            <MessageSquarePlus className="size-4" />
          </Button>
        </div>
        <div className="flex max-h-[40svh] min-h-0 flex-col gap-1 overflow-y-auto lg:max-h-none lg:flex-1 lg:pb-0">
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
      </aside>

      {/* middle: chat pane on top, X-ray below it from lg (right column from 2xl) */}
      <section className="flex min-w-0 flex-1 flex-col lg:h-full lg:min-h-0 lg:pl-5 2xl:pr-5">
        {/* transcript: anchored to the bottom while short, grows + scrolls once long.
            anchor via the sentinel's mt-auto, NOT justify-end — justify-end in a
            scroll container makes the top rows unreachable once content overflows */}
        <div className="flex min-h-[45svh] flex-1 flex-col gap-3 overflow-y-auto pb-4 lg:min-h-0">
          {exchanges.map((x, i) =>
            x.kind === "turn" ? (
              <div key={i}>
                <button
                  className="w-full cursor-pointer text-start"
                  title="view trace"
                  onClick={() => setOpenTrace({ ...x.turn })}
                >
                  <TwoBubbles q={x.turn.question ?? ""} a={x.turn.answer} error={x.turn.error} refused={x.turn.outcome === "refused"} />
                </button>
              </div>
            ) : null,
          )}
          {showLiveExchange && (
            <button
              className="w-full cursor-pointer text-start disabled:cursor-default"
              title={busy ? undefined : "view trace"}
              onClick={() =>
                setOpenTrace({
                  id: meta?.requestId ?? "-",
                  createdAt: new Date().toISOString(),
                  capability: capability === "chat" ? "chat" : "support-assistant",
                  keyLabel: null,
                  backendId: meta?.backend?.id ?? "none",
                  modelId: meta?.backend?.model ?? "none",
                  tokens: final?.metering ? final.metering.tokens.prompt + final.metering.tokens.completion : undefined,
                  costUsd: final?.metering?.estimatedCostUsd,
                  latencyMs: final?.metering?.latencyMs,
                  outcome: fault ? "failed" : final?.refused ? "refused" : "ok",
                  question: input,
                  answer: fault ? null : final?.refused ? final.message ?? null : (final?.answer ?? streamText) || null,
                  retrievalConfidence: meta?.retrieval?.confidence ?? null,
                  retrieval: meta?.retrieval?.entries ?? null,
                  intent: meta?.intent?.intent ?? null,
                  error: fault?.message ?? null,
                  plan: meta?.routingPlan ?? [],
                  fallbackTriggered: meta?.fallbackTriggered,
                })
              }
              disabled={busy}
            >
              <TwoBubbles
                q={input}
                a={final?.refused ? final.message ?? "" : (final?.answer ?? streamText) || null}
                error={fault?.message ?? null}
                refused={final?.refused === true}
                live={busy && !streamText}
              />
            </button>
          )}
          {exchanges.length === 0 && !showLiveExchange && (
            <div className="mt-6">
              <p className="mb-3 text-center text-sm text-muted-foreground">start with one of these, or type your own</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <Button key={ex} variant="outline" size="sm" className="rounded-full" onClick={() => setInput(ex)}>
                    <Sparkles className="size-3.5 text-muted-foreground" />
                    {ex}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {/* scroll target + bottom anchor (see note on the container) */}
          <div ref={chatBottomRef} className="mt-auto" />
        </div>

        {/* composer, Claude/Gemini-style: stays put at the bottom of the pane */}
        <div className="sticky bottom-24 z-10 md:bottom-4">
          <Card>
            <CardContent className="p-4">
              <form onSubmit={send}>
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask a support question…"
                  rows={3}
                  onKeyDown={(e) => {
                    // Enter sends, Shift+Enter (and IME composition) inserts a newline
                    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    void send(e);
                  }}
                />
                <div className="mt-3 flex items-center justify-between gap-2">
                  {/* capability mode picker, inside the composer (Gemini-style) */}
                  <div className="flex items-center gap-1">
                    <Button
                      type="button" size="sm" variant={capability === "assistant" ? "secondary" : "ghost"}
                      className="h-7 rounded-full px-2.5 text-xs"
                      onClick={() => onCapability("assistant")}
                      title="grounded support assistant — retrieval, intent, refusal"
                    >
                      <Sparkles className="size-3" /> assistant
                    </Button>
                    <Button
                      type="button" size="sm" variant={capability === "chat" ? "secondary" : "ghost"}
                      className="h-7 rounded-full px-2.5 text-xs"
                      onClick={() => onCapability("chat")}
                      title="plain chat capability — no retrieval"
                    >
                      <MessageSquareText className="size-3" /> chat
                    </Button>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="icon" onClick={() => void newSession()} title="new session" className="size-7 text-muted-foreground hidden sm:inline-flex">
                      <MessageSquarePlus className="size-3.5" />
                    </Button>
                    {busy ? (
                      <Button type="button" variant="outline" size="icon" onClick={() => abortRef.current?.abort()} title="stop" className="size-8">
                        <Square className="size-3.5" />
                      </Button>
                    ) : (
                      <Button type="submit" size="icon" disabled={!input.trim()} title="send" className="size-8 rounded-full">
                        <ArrowUp className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* X-ray under the chat on lg–2xl, sized to its content (no blank tail) */}
        <div className="hidden min-w-0 flex-col gap-4 lg:flex 2xl:hidden lg:mt-5 lg:max-h-[45svh] lg:shrink-0 lg:overflow-y-auto lg:border-t lg:border-border lg:pt-5">
          <Xray meta={meta ?? restored?.meta ?? null} final={final ?? restored?.final ?? null} fault={fault ?? restored?.fault ?? null} capability={capability} />
        </div>
      </section>

      {/* X-ray as its own right column on 2xl, divider on its left */}
      <aside className="hidden min-w-0 shrink-0 flex-col gap-4 overflow-y-auto 2xl:flex 2xl:h-full 2xl:w-[340px] 2xl:border-l 2xl:border-border 2xl:pl-5">
        <Xray meta={meta ?? restored?.meta ?? null} final={final ?? restored?.final ?? null} fault={fault ?? restored?.fault ?? null} capability={capability} />
      </aside>

      <TraceDialog trace={openTrace} onClose={() => setOpenTrace(null)} />
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

export function Xray({ meta, final, fault, capability = "assistant" }: { meta: StreamMeta | null; final: StreamFinal | null; fault: Fault | null; capability?: Capability }): React.ReactElement {
  // Container-width layout: cards stack in narrow columns, row up in the
  // wide strip — viewport breakpoints can't express both from one component.
  return (
    <div className="@container">
      <div className="grid gap-4 @xl:grid-cols-3">
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
                <p className="text-xs text-muted-foreground">
                  {meta.intent.confidence === null ? "confidence — not stored" : `confidence ${meta.intent.confidence.toFixed(2)}`}
                </p>
              </div>
            ) : <p className="text-sm text-muted-foreground">waiting…</p>}
          </CardContent>
        </Card>

        <Card className="@xl:col-span-3">
          <CardHeader><CardTitle>metering</CardTitle></CardHeader>
          <CardContent>
            {final?.metering ? (
              <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
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