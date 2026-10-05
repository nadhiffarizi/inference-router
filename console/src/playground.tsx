import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, CircleSlash, KeyRound, MessageSquarePlus, MessageSquareText, Square, Sparkles, Trash2 } from "lucide-react";
import { deleteChatSession, fetchChatSessions, fetchSessionTimeline, postStream, type ChatSessionRow, type StreamFinal, type StreamMeta, type Turn } from "./api";
import { useKeys } from "./keys";
import { Badge } from "./components/ui/badge";
import { KeyValBadge } from "./components/ui/key-val-badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input, Textarea } from "./components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { cn, usd } from "./lib/utils";
import { NO_ANSWER_TEXT } from "./lib/copy";
import { Bubble, Markdown } from "./lib/chatui";
import { TraceDialog, type TracePayload } from "./components/trace-dialog";
import { RouteChain } from "./components/route-chain";

/**
 * Playground: three resizable panels — session rail (Langfuse-style grouping),
 * chat pane, inspector/X-ray — chat-only below lg. Gated on an issued API key
 * (the product-team integration flow). Sessions are grouping only — the
 * assistant stays single-turn by design.
 */

import { PLAYGROUND_KEY_STORAGE as KEY_STORAGE, PLAYGROUND_SESSION_STORAGE as SESSION_STORAGE } from "./auth";

type Fault = { code: string; message: string };

const EXAMPLES = ["how do I cancel my order?", "what payment methods do you accept?", "what is the meaning of life?"];

export type Capability = "assistant" | "chat";

export function Playground(): React.ReactElement {
  const [pastedKey, setPastedKey] = useState<string | null>(() => localStorage.getItem(KEY_STORAGE));
  // set when a 401 proves the stored key is dead — the gate opens with an
  // explanation; cleared on any successful reconnect
  const [invalidKey, setInvalidKey] = useState(false);
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
    setInvalidKey(false);
    setPastedKey(trimmed);
  }

  /** The gateway rejected the stored key (unknown/not yours): drop the
      connection so the gate comes back — a bad key must not wedge the chat. */
  function invalidStoredKey(): void {
    localStorage.removeItem(KEY_STORAGE);
    setPastedKey(null);
    setInvalidKey(true);
  }

  if (!pastedKey) {
    return (
      <ConnectGate
        keysPresent={keys.keys.length > 0}
        onIssued={connect}
        onConnect={connect}
        error={keys.error}
        invalidKey={invalidKey}
      />
    );
  }
  return <SessionChat apiKey={pastedKey} capability={capability} onCapability={switchCapability} onInvalidKey={invalidStoredKey} />;
}

/** The issue → copy → paste gate (keys are one and irreplaceable). */
function ConnectGate({
  keysPresent,
  onIssued,
  onConnect,
  error,
  invalidKey = false,
}: {
  keysPresent: boolean;
  onIssued: (key: string) => void;
  onConnect: (key: string) => void;
  error: string | null;
  invalidKey?: boolean;
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
          {invalidKey && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              The key the playground connected with was <strong>rejected as unknown</strong> — most often it was
              copied in masked form (<span className="font-mono">sk_…0000</span> on the card is a hint, not a key),
              or it predates a database reset, or it belongs to another account. Reveal the key on the
              {" "}API Keys page and paste the full plaintext.
            </div>
          )}
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
 * unknown/null on restore. Refused turns (policy gate, unusable output) keep
 * their refusal so the X-ray explains itself instead of re-displaying intent
 * for a question the gateway never answered.
 */
type RestoredXray = { meta: StreamMeta | null; final: StreamFinal | null; fault: Fault | null; refused: boolean };

function restoredXray(t: Turn): RestoredXray {
  const refused = t.outcome === "refused";
  return {
    refused,
    meta: {
      requestId: t.id,
      backend: { id: t.backendId, label: t.backendId, model: t.modelId },
      fallbackTriggered: t.fallbackTriggered,
      routingPlan: t.plan,
      retrieval: t.retrieval ? { entries: t.retrieval, confidence: t.retrievalConfidence ?? 0 } : undefined,
      intent: refused ? { intent: null, confidence: null } : { intent: t.intent, confidence: null },
    },
    final: t.outcome === "ok" || refused ? {
      metering: {
        model: t.modelId,
        tokens: { prompt: t.promptTokens, completion: t.completionTokens },
        latencyMs: t.latencyMs,
        estimatedCostUsd: t.costUsd,
        costSource: "", // not persisted per turn
      },
    } : null,
    fault: t.outcome === "failed" ? { code: t.outcome, message: t.error ?? t.outcome } : null,
  };
}

function SessionChat({
  apiKey, capability, onCapability, onInvalidKey,
}: { apiKey: string; capability: Capability; onCapability: (c: Capability) => void; onInvalidKey?: () => void }): React.ReactElement {
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
  /** The message in flight, kept separately from the composer: `input` clears
      on send, but the bubble must still show what the caller typed — and on a
      rejected request (429/401/network) no turn is ever persisted, so this is
      the only place the text lives. */
  const [sentInput, setSentInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** Demo lever: pin the scripted mock first (mock runs in hang mode) so the
      router timeout → fallback fires on demand, in the UI, with zero env
      changes or restarts. Assistant-only — the chat schema has no pin. */
  const [demoFault, setDemoFault] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  /** Latest requested session for loadTurns — stales out slow list/timeline responses. */
  const turnsReqRef = useRef<string | null>(null);
  const [openTrace, setOpenTrace] = useState<TracePayload | null>(null);
  const isDesktop = useDesktop();

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
    setSentInput(input); // the bubble outlives the composer: keep the echo before clearing
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
        { message: input, sessionId: activeExt,
          ...(capability === "chat" ? { maxTokens: 500 } : {}),
          ...(capability === "assistant" && demoFault ? { backendPin: "mock" } : {}) },
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
          onError: (code, message) => {
            setFault({ code, message });
            // 401 means the stored key is provably dead — drop the connection
            // and let the connect gate explain; retrying can't succeed
            if (code === "unauthorized") onInvalidKey?.();
          },
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

  // once the persisted turn arrives, the timeline bubble replaces the live one
  // (final alone would render the same exchange twice)
  const showLiveExchange = busy || pendingFinal || fault;

  /* ── shared middle-column markup, rendered from either breakpoint branch ── */

  // transcript: anchored to the bottom while short, grows + scrolls once long.
  // anchor via the sentinel's mt-auto, NOT justify-end — justify-end in a
  // scroll container makes the top rows unreachable once content overflows
  const transcript = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden pb-4 pt-5">
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
              question: sentInput,
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
            q={sentInput}
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
  );

  // Composer sits at the bottom of the column (flex layout does the pinning —
  // sticky is gone now that the column itself never scrolls) and carries **no**
  // horizontal chrome of its own: the padded column around transcript +
  // composer is the only horizontal inset, so both bubble edges line up with
  // the textarea's edges instead of bubbles touching the panel edge while the
  // composer's card padding inset it.
  const composer = (
    <form onSubmit={send} className="shrink-0">
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
          {capability === "assistant" && (
            <Button
              type="button" size="sm"
              variant={demoFault ? "destructive" : "ghost"}
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={() => setDemoFault((v) => !v)}
              title={demoFault
                ? "demo fault ON — the failing mock is pinned first: router timeout → fallback fires"
                : "demo fault off — pin the failing mock first to watch timeout → fallback fire (assistant mode)"}
            >
              <CircleSlash className="size-3" /> {demoFault ? "fault: on" : "fault: off"}
            </Button>
          )}
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
  );

  // refusing is a decision, not an outage: the X-ray must carry it (the policy
  // gate, the zero-token metering, the "no intent applied" note)
  const refused = (meta !== null || final !== null)
    ? (meta?.refusal === true || final?.refused === true)
    : (restored?.refused ?? false);
  const xray = (
    <Xray
      meta={meta ?? restored?.meta ?? null}
      final={final ?? restored?.final ?? null}
      fault={fault ?? restored?.fault ?? null}
      refused={refused}
      capability={capability}
    />
  );
  const traceDialog = <TraceDialog trace={openTrace} onClose={() => setOpenTrace(null)} />;

  /* One padded column for the whole chat: the transcript and the composer live
     in a shared container with uniform horizontal padding, so every chat
     element — user bubble right edge, assistant bubble left edge, textarea —
     sits on the same left/right margins instead of the bubbles touching the
     panel edge while the composer's own padding inset it. Vertical rhythm
     stays here (pinned to the bottom); the transcript handles its own. */
  const chatColumn = (
    <div className="flex h-full min-h-0 flex-1 flex-col px-4 md:px-6">
      {transcript}
      <div className="pb-1 pt-4">{composer}</div>
    </div>
  );

  // below lg: chat-only, no rail — the transcript is the one scroll container
  if (!isDesktop) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {chatColumn}
        {traceDialog}
      </div>
    );
  }

  // lg and up: three resizable panels — sessions / chat / inspector (X-ray).
  // The Group fills the main column exactly (the shell pins main's height and
  // hides overflow there), so no window-level scrollbar ever exists to fight
  // with; each panel scrolls internally instead.
  return (
    <ResizablePanelGroup direction="horizontal">
      <ResizablePanel id="sessions" defaultSize="20" minSize="15" maxSize="30">
        <aside className="flex h-full min-w-0 flex-col">
          <div className="flex shrink-0 items-center justify-between p-4 pb-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">sessions</p>
            <Button size="sm" variant="ghost" onClick={() => void newSession()} title="new session">
              <MessageSquarePlus className="size-4" />
            </Button>
          </div>
          {/* strict scroll containment: the rail scrolls here, never the panel */}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-4 pb-4">
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
      </ResizablePanel>

      <ResizableHandle id="split-sessions" withHandle />

      <ResizablePanel id="chat" defaultSize="50" minSize="35">
        {chatColumn}
      </ResizablePanel>

      <ResizableHandle id="split-inspector" withHandle />

      <ResizablePanel id="inspector" defaultSize="30" minSize="20" maxSize="45">
        {/* inspector scrolls in its own column; p-4 keeps cards off the divider */}
        <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden p-4">{xray}</div>
      </ResizablePanel>

      {traceDialog}
    </ResizablePanelGroup>
  );
}

/** Tailwind's lg breakpoint in px, without a media-query helper dependency. */
function useDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 64rem)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 64rem)");
    const onChange = (e: MediaQueryListEvent): void => setIsDesktop(e.matches);
    setIsDesktop(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

function TwoBubbles({ q, a, error, refused, live }: { q: string; a: string | null; error: string | null; refused?: boolean; live?: boolean }): React.ReactElement {
  return (
    // the user bubble is right-aligned, the assistant's spans wide — without
    // this gap the user bubble's bottom corner sits flush on the answer's
    <div className="space-y-2.5">
      <Bubble role="user">{q}</Bubble>
      {error ? (
        <Bubble role="assistant" tone="error">{error}</Bubble>
      ) : refused ? (
        // refusals persist their own message now; pre-persist refusals have
        // none — show the shared missing-answer copy, never an empty bubble
        <Bubble role="assistant" tone="warning">{a || NO_ANSWER_TEXT}</Bubble>
      ) : (
        <Bubble role="assistant" live={live}>
          <Markdown text={a ?? ""} />
        </Bubble>
      )}
    </div>
  );
}

export function Xray({ meta, final, fault, refused = false, capability = "assistant" }: { meta: StreamMeta | null; final: StreamFinal | null; fault: Fault | null; refused?: boolean; capability?: Capability }): React.ReactElement {
  // Container-width layout: cards stack in narrow columns, row up in the
  // wide strip — viewport breakpoints can't express both from one component.
  // Every card carries w-full min-w-0: panels get narrow, and without it the
  // grid children overflow and force a horizontal scrollbar in the inspector.
  return (
    <div className="@container w-full min-w-0">
      <div className="grid w-full min-w-0 gap-4 @xl:grid-cols-3">
        <Card className="w-full min-w-0">
          <CardHeader><CardTitle>routing</CardTitle></CardHeader>
          <CardContent className="w-full min-w-0 space-y-2">
            {fault && (
              <div className="flex items-center gap-2">
                <KeyValBadge label="fault" value={fault.code} variant="destructive" />
                <span className="min-w-0 truncate text-xs text-muted-foreground">{fault.message}</span>
              </div>
            )}
            {meta ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <KeyValBadge label="backend" value={meta.backend?.id ?? "none"} variant="info" title={meta.backend?.label} />
                  {refused && <KeyValBadge label="status" value="refused" variant="warning" />}
                  <KeyValBadge label="model" value={meta.backend?.model ?? "none"} variant="outline" title={meta.backend?.model} />
                  {meta.fallbackTriggered ? <Badge variant="warning">fallback fired</Badge> : <Badge variant="secondary">first candidate answered</Badge>}
                </div>
                {/* the chain, not just the winner: answered / failed / never called, in call order */}
                <div className="mt-1"><RouteChain plan={meta.routingPlan} /></div>
              </>
            ) : !fault && <p className="text-sm text-muted-foreground">waiting for first request…</p>}
          </CardContent>
        </Card>

        <Card className="w-full min-w-0">
          <CardHeader><CardTitle>retrieval</CardTitle></CardHeader>
          <CardContent className="w-full min-w-0">
            {meta?.retrieval ? (
              <div className="w-full min-w-0 space-y-2">
                <p className="flex items-baseline gap-1">
                  <span className="text-2xl font-semibold">{meta.retrieval.confidence.toFixed(2)}</span>
                  <span className="text-xs text-muted-foreground">confidence</span>
                  {refused && <Badge variant="warning" className="ml-auto text-[10px]">below refusal floor</Badge>}
                </p>
                {refused && (
                  <p className="text-xs text-muted-foreground">
                    no answer was generated — policy refused rather than guess.
                  </p>
                )}
                <ul className="min-w-0 space-y-1.5">
                  {/* truncate + title: full question is on hover, whole string scrolls away */}
                  {meta.retrieval.entries.map((e) => (
                    <li key={e.id} className="min-w-0 truncate text-xs text-muted-foreground" title={e.question}>
                      <Badge variant="outline" className="mr-1.5 text-[10px]">{e.intent}</Badge>
                      {e.question}
                    </li>
                  ))}
                </ul>
              </div>
            ) : <p className="text-sm text-muted-foreground">waiting…</p>}
          </CardContent>
        </Card>

        <Card className="w-full min-w-0">
          <CardHeader><CardTitle>intent</CardTitle></CardHeader>
          <CardContent className="w-full min-w-0">
            {refused ? (
              // a refusal is a policy decision taken before any answer — there
              // is no intent to show for it
              <div className="space-y-1">
                <span className="block truncate text-lg font-semibold text-muted-foreground">none</span>
                <p className="text-xs text-muted-foreground">refused before any answer — no intent applied</p>
              </div>
            ) : meta?.intent ? (
              <div className="space-y-1">
                <span
                  className={cn("block truncate text-lg font-semibold", !meta.intent.intent && "text-muted-foreground")}
                  title={meta.intent.intent ?? "none"}
                >
                  {meta.intent.intent ?? "none"}
                </span>
                <p className="text-xs text-muted-foreground">
                  {meta.intent.confidence === null ? "confidence — not stored" : `confidence ${meta.intent.confidence.toFixed(2)}`}
                </p>
              </div>
            ) : <p className="text-sm text-muted-foreground">waiting…</p>}
          </CardContent>
        </Card>

        <Card className="@xl:col-span-3 w-full min-w-0">
          <CardHeader><CardTitle>metering</CardTitle></CardHeader>
          <CardContent className="w-full min-w-0">
            {final?.metering ? (
              <div className="grid w-full min-w-0 grid-cols-2 gap-3 @xl:grid-cols-4">
                <Metric label="model" value={final.metering.model.replace(/^google\/|^anthropic\//, "")} />
                <Metric label="latency" value={`${final.metering.latencyMs} ms`} />
                <Metric label="tokens" value={`${final.metering.tokens.prompt} + ${final.metering.tokens.completion}`} />
                <Metric label="cost" value={usd(final.metering.estimatedCostUsd)} hint={final.metering.costSource} />
              </div>
            ) : <p className="text-sm text-muted-foreground">waiting…</p>}
            {refused && final?.metering && (
              <p className="mt-3 text-xs text-muted-foreground">refused before routing — no model called, nothing spent.</p>
            )}
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
    // min-w-0 on the cell + truncate on the value keeps ids like
    // gemini-2.5-flash-lite on one line (ellipsis + hover title) instead of
    // wrapping character by character in a narrow grid column
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-sm font-semibold" title={value}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}