import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Play, RotateCcw, Search } from "lucide-react";
import { postStream, type StreamFinal, type StreamMeta } from "./api";
import { useKeys } from "./keys";
import { useAuth } from "./auth";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input, Textarea } from "./components/ui/input";
import { usd } from "./lib/utils";

/**
 * Demo Lab (DEMO_CONTROLS=1 gateway flag): one card per assessment scenario.
 * A scene applies any levers it needs (runtime failure modes, fault injection,
 * own-tenant quota caps), fires the curated request against the real gateway,
 * shows the machine-readable result, and — unless said otherwise — puts the
 * levers back. The assessor clicks, then reads: no env vars, no redeploy.
 */

type DemoSettings = {
  routingChain: string;
  mock: { failureMode: string; failureRate: number; firstByteDelayMs: number; chunkDelayMs: number };
  faults: Record<string, string>;
};

type DemoStatus = {
  enabled: boolean;
  settings: DemoSettings;
  backends: { id: string; label: string; tier: string; modelId: string; timeoutMs: number }[];
  thresholds: Record<string, number>;
  tenants: { id: number; name: string; requestsPerDay: number; tokensPerDay: number; budgetUsdPerDay: number }[];
};

type ProbeResult = {
  question: string;
  chars: number;
  retrieval: { confidence: number; topK: number };
  thresholds: { refuseBelowConfidence: number; tierBSwapBelowConfidence: number };
  verdict: { refuses: boolean; weak: boolean; complexity: string; primary: string; reason: string };
};

type Step = {
  label: string;
  status?: number;
  body?: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } & Record<string, unknown>;
  meta?: StreamMeta;
  final?: StreamFinal;
  deltas?: string;
  errorCode?: string;
  streamError?: string;
  note?: string;
};

type Scene = {
  id: string;
  group: "auth & input validation" | "routing" | "failure & fallback" | "quota";
  title: string;
  blurb: string;
  expect: string;
  /** Scenes that stream with the chosen key (all but the key-missing ones). */
  needsKey?: boolean;
  run: (fire: Fire) => Promise<Step[]>;
};

type Fire = {
  http: (label: string, body: unknown, opts?: { key?: string | null; path?: string }) => Promise<Step>;
  stream: (label: string, body: unknown, opts?: { key?: string | null; path?: string }) => Promise<Step>;
  note: (label: string, text: string) => Step;
  setLevers: (patch: Record<string, unknown>) => Promise<void>;
  setTenant: (patch: { requestsPerDay?: number; budgetUsdPerDay?: number }) => Promise<{ previous?: { requestsPerDay: number; budgetUsdPerDay: number } }>;
  used: { requestCount: number; usdSpend: number };
};

const QUESTION_ON_KB = "how do I cancel my order?";
const QUESTION_REFUSAL = "is the moon made of cheese?";
/** Candidates the weak-band scene probes live — first landing in [floor, swap) wins.
    Probe-measured (2026-10): 0.50 / 0.55 / 0.46 against the shipped KB. */
const WEAK_CANDIDATES = [
  "can I sell items on the marketplace?",
  "What countries do you ship to and how much is it",
  "is there a student discount on subscriptions?",
];

const ACTION_VARIANT: Record<string, "success" | "destructive" | "warning" | "secondary" | "info"> = {
  served: "success",
  failed: "destructive",
  abandoned: "warning",
  blocked_policy: "warning",
  skipped: "secondary",
};

export function DemoLab(): React.ReactElement {
  const { me } = useAuth();
  const keys = useKeys();
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [keyIdx, setKeyIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Step[]>>({});

  useEffect(() => {
    void (async () => {
      const res = await fetch("/v1/console/demo");
      if (res.status === 401 || res.status === 403) {
        setDisabled(true);
        return;
      }
      if (res.ok) setStatus((await res.json()) as DemoStatus);
    })();
  }, []);

  const apiKey = keys.keys[keyIdx]?.key ?? keys.keys[0]?.key ?? "";

  const putSettings = useCallback(async (patch: Record<string, unknown>): Promise<void> => {
    await fetch("/v1/console/demo/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  }, []);

  const putTenant = useCallback(async (patch: { requestsPerDay?: number; budgetUsdPerDay?: number }) => {
    const id = me?.user.tenant.id ?? 0;
    const res = await fetch(`/v1/console/demo/tenants/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const data = (await res.json()) as { previous?: { requestsPerDay: number; budgetUsdPerDay: number } };
    return data;
  }, [me]);

  const fire: Fire = {
    http: async (label, body, opts) => {
      const key = opts?.key === null ? undefined : (opts?.key ?? apiKey);
      const res = await fetch(opts?.path ?? "/v1/support-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
      let parsed: Step["body"];
      try { parsed = (await res.json()) as Step["body"]; } catch { parsed = { raw: await res.text() }; }
      return { label, status: res.status, body: parsed };
    },
    stream: async (label, body, opts) => {
      const key = opts?.key === null ? undefined : (opts?.key ?? apiKey);
      const step: Step = { label };
      await postStream(opts?.path ?? "/v1/support-assistant", body, key ?? "", {
        onMeta: (m) => { step.meta = m; },
        onDelta: (t) => { step.deltas = (step.deltas ?? "") + t; },
        onFinal: (f) => { step.final = f; },
        onError: (code, message) => {
          step.errorCode = code;
          step.streamError = message;
        },
        onDone: () => undefined,
      });
      return step;
    },
    note: (label, text) => ({ label, note: text }),
    setLevers: putSettings,
    setTenant: putTenant,
    used: me?.usage ?? { requestCount: 0, usdSpend: 0 },
  };

  if (disabled) {
    return (
      <div className="mx-auto max-w-xl pt-6">
        <Card>
          <CardHeader><CardTitle>Demo Lab is not enabled here</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            This deployment booted without <code className="font-mono">DEMO_CONTROLS=1</code>, so the scenario levers are
            closed (fail-closed, like every other lever). Set the flag in <code className="font-mono">docker-compose.yml</code>
            / env and restart.
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!status) {
    return <div className="mx-auto max-w-xl pt-6 text-sm text-muted-foreground">loading demo state…</div>;
  }
  if (keys.keys.length === 0) {
    return (
      <div className="mx-auto max-w-xl pt-6">
        <Card>
          <CardHeader><CardTitle>issue a key first</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Scenes fire real gateway requests — they need your API key. Issue one on the <b>API Keys</b> page, come back here.
          </CardContent>
        </Card>
      </div>
    );
  }

  const s = status.settings;
  const dirtyLevers =
    s.routingChain !== "" || s.mock.failureMode !== "none" || Object.values(s.faults).some((f) => f !== "healthy");

  return (
    <div className="mx-auto max-w-6xl space-y-6 pt-4">
      <ControlsCard status={status} onRefresh={setStatus} />
      <ProbeCard />
      {dirtyLevers && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-center justify-between gap-3 p-4 text-sm">
            <span>Scenario levers are left active (chain / mock mode / faults) — run them again or reset before other testing.</span>
            <Button size="sm" variant="outline" onClick={() => void (async () => { await fetch("/v1/console/demo/reset", { method: "POST" }); const r = await fetch("/v1/console/demo"); setStatus((await r.json()) as DemoStatus); })()}>
              <RotateCcw className="size-3.5" /> reset levers
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {SCENES.map((scene) => (
          <Card key={scene.id}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="size-4 text-muted-foreground" /> {scene.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{scene.blurb}</p>
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline" className="text-[11px] text-muted-foreground">expect: {scene.expect}</Badge>
                <Button
                  size="sm"
                  disabled={!!busy || (scene.needsKey && !apiKey)}
                  onClick={() => {
                    setBusy(scene.id);
                    void (async () => {
                      try {
                        const steps = await scene.run({ ...fire, used: me?.usage ?? { requestCount: 0, usdSpend: 0 } });
                        setResults((r) => ({ ...r, [scene.id]: steps }));
                      } finally {
                        setBusy(null);
                        const r = await fetch("/v1/console/demo");
                        if (r.ok) setStatus((await r.json()) as DemoStatus);
                        void keys.reload();
                      }
                    })();
                  }}
                >
                  <Play className="size-3.5" /> {busy === scene.id ? "running…" : "run"}
                </Button>
              </div>
              {(results[scene.id] ?? []).map((st, i) => <StepView key={i} step={st} />)}
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Key used for fired requests: <span className="font-mono">{keys.keys[keyIdx]?.label ?? "??"}</span>
        {keys.keys.length > 1 && (
          <select className="ml-2 rounded border bg-background px-1 py-0.5 text-xs" value={keyIdx} onChange={(e) => setKeyIdx(Number(e.target.value))}>
            {keys.keys.map((k, i) => <option key={k.key} value={i}>{k.label}</option>)}
          </select>
        )}
        {" "}· every fired request is metered on this tenant like a real integration.
      </p>
    </div>
  );
}

/** The one-click levers themselves, for free play between scripted scenes. */
function ControlsCard({ status, onRefresh }: { status: DemoStatus; onRefresh: (s: DemoStatus) => void }): React.ReactElement {
  const s = status.settings;
  const me = useAuth().me;
  const [reqLimit, setReqLimit] = useState("");
  const myTenant = status.tenants.find((t) => me?.user.tenant.id === t.id) ?? status.tenants[0];
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">levers (live, no restart)</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3 md:grid-cols-3">
          <Lever label="routing chain" value={s.routingChain || "policy order"} />
          <Lever label="mock mode" value={s.mock.failureMode === "none" ? "healthy" : `${s.mock.failureMode} · rate ${s.mock.failureRate}`} />
          <Lever label="fault injection" value={Object.entries(s.faults).filter(([, f]) => f !== "healthy").map(([id, f]) => `${id}: ${f}`).join(" · ") || "none"} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void (async () => { await fetch("/v1/console/demo/reset", { method: "POST" }); const r = await fetch("/v1/console/demo"); onRefresh((await r.json()) as DemoStatus); })()}>
            <RotateCcw className="size-3.5" /> reset to boot defaults
          </Button>
          {myTenant && (
            <>
              <Input className="w-24 font-mono" placeholder="req/day" value={reqLimit} onChange={(e) => setReqLimit(e.target.value)} />
              <Button size="sm" variant="outline" onClick={() => void (async () => {
                const n = Number(reqLimit);
                if (!Number.isInteger(n) || n < 1) return;
                await fetch(`/v1/console/demo/tenants/${myTenant.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestsPerDay: n }) });
                const r = await fetch("/v1/console/demo"); onRefresh((await r.json()) as DemoStatus);
              })()}>
                set request quota
              </Button>
              <span className="text-xs text-muted-foreground">
                {myTenant.name}: {myTenant.requestsPerDay} req/day · ${myTenant.budgetUsdPerDay}/day
              </span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Lever({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-xs">{value}</p>
    </div>
  );
}

/** Probe: what WOULD the gateway do with this question? No model call. */
function ProbeCard(): React.ReactElement {
  const [q, setQ] = useState("what is the meaning of life?");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">confidence probe — the refusal floor & weak band, inspectable</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="type a question…" />
          <Button size="sm" disabled={busy || !q.trim()} onClick={() => void (async () => {
            setBusy(true); setErr(null);
            const res = await fetch("/v1/console/demo/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
            setBusy(false);
            if (res.ok) setProbe((await res.json()) as ProbeResult); else setErr(`HTTP ${res.status}`);
          })()}>
            <Search className="size-3.5" /> probe
          </Button>
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        {probe && (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={probe.verdict.refuses ? "destructive" : probe.verdict.weak ? "warning" : "success"}>
                confidence {probe.retrieval.confidence.toFixed(2)}
              </Badge>
              {probe.verdict.refuses && <span className="text-xs text-muted-foreground">below floor {probe.thresholds.refuseBelowConfidence} → refuses, no model call</span>}
              {probe.verdict.weak && <span className="text-xs text-muted-foreground">in the weak band [{probe.thresholds.refuseBelowConfidence}, {probe.thresholds.tierBSwapBelowConfidence}) → capable tier</span>}
              {!probe.verdict.refuses && !probe.verdict.weak && <span className="text-xs text-muted-foreground">strong retrieval → complexity decides</span>}
              <Badge variant="secondary">{probe.verdict.complexity}</Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{probe.verdict.reason}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StepView({ step }: { step: Step }): React.ReactElement {
  const err = step.body?.error;
  const code = (step.body as { error?: { code?: string } })?.error?.code;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{step.label}</span>
        <div className="flex items-center gap-1.5">
          {step.status !== undefined && (
            <Badge variant={step.status < 300 ? "success" : step.status < 500 ? "warning" : "destructive"}>HTTP {step.status}</Badge>
          )}
          {code ? <Badge variant="outline" className="font-mono text-[10px]">{code}</Badge> : null}
          {step.errorCode && step.errorCode !== code && <Badge variant="outline" className="font-mono text-[10px]">{step.errorCode}</Badge>}
          {step.errorCode && <Badge variant="destructive" className="text-[10px]">stream error</Badge>}
          {step.meta?.refusal && <Badge variant="warning">refused</Badge>}
          {step.meta?.fallbackTriggered && <Badge variant="info">fallback</Badge>}
          {step.meta && !step.meta.refusal && step.meta.backend && (
            <Badge variant="secondary" className="font-mono text-[10px]">{step.meta.backend.id}</Badge>
          )}
          {step.meta?.retrieval && <Badge variant="outline" className="font-mono text-[10px]">conf {step.meta.retrieval.confidence.toFixed(2)}</Badge>}
        </div>
      </div>
      {step.note && <p className="text-xs text-muted-foreground">{step.note}</p>}
      {step.meta?.routingPlan && (
        <div className="flex flex-wrap gap-1">
          {step.meta.routingPlan.map((p, i) => (
            <Badge key={i} variant={ACTION_VARIANT[p.action] ?? "outline"} className="text-[10px]">
              {p.backendId} · {p.action}
            </Badge>
          ))}
        </div>
      )}
      {step.deltas && <p className="truncate text-xs text-muted-foreground">streamed: “{step.deltas.slice(0, 120)}{step.deltas.length > 120 ? "…" : ""}”</p>}
      {err && <p className="text-xs text-destructive">{err.message}</p>}
      {step.streamError && <p className="text-xs text-destructive">{step.streamError}</p>}
      {step.final?.refused && step.final.message && <p className="text-xs text-amber-600 dark:text-amber-400">{step.final.message}</p>}
      {step.final && !step.final.refused && step.final.metering && (
        <p className="text-xs text-muted-foreground">
          served by {step.final.metering.model} · {step.final.metering.tokens.prompt + step.final.metering.tokens.completion} tokens · {usd(step.final.metering.estimatedCostUsd)}
          {typeof step.final.metering.ttftMs === "number" ? ` · ttft ${step.final.metering.ttftMs}ms` : ""}
        </p>
      )}
      {step.final?.quota && (
        <p className="text-xs text-muted-foreground">
          quota: {step.final.quota.used.requestCount}/{step.final.quota.limits.requestsPerDay} req
          {typeof step.final.quota.used.usdSpend === "number" ? ` · ${usd(step.final.quota.used.usdSpend)}/$${step.final.quota.limits.budgetUsdPerDay}` : ""}
        </p>
      )}
    </div>
  );
}

/** ---- the assessment scenarios ---- */

const SCENES: Scene[] = [
  {
    id: "no-key", group: "auth & input validation", title: "missing API key", expect: "401 unauthorized",
    blurb: "Fire with NO Authorization header — the gateway's first gate, identical for streaming and non-stream routes.",
    needsKey: false,
    run: (f) => Promise.all([
      f.http("assistant without a key", { message: QUESTION_ON_KB }, { key: null }),
      f.http("chat without a key", { message: "hi" }, { key: null, path: "/v1/chat" }),
    ]).then(([a, b]) => [a, b, f.note("both endpoints", "same 401 shape: machine-readable {error:{code,message}}, no quota consumed")]),
  },
  {
    id: "bad-key", group: "auth & input validation", title: "unknown API key", expect: "401 unauthorized",
    blurb: "A well-formed but unissued key: SHA-256 lookup misses, auth fails closed before anything else runs.",
    needsKey: false,
    run: async (f) => [
      await f.http("assistant with a bogus key", { message: QUESTION_ON_KB }, { key: "sk_definitely_not_real_0000000000000000" }),
      f.note("tenant lookup", "one key maps to exactly one tenant — there is no cross-tenant path"),
    ],
  },
  {
    id: "long-input", group: "auth & input validation", title: "input over the limit", expect: "400 invalid_input",
    blurb: "Messages are schema-capped at 4000 chars — a rejection before routing, before quota, before any model call.",
    needsKey: false,
    run: async (f) => [await f.http("4001-char message", { message: "x".repeat(4001) }, { key: undefined })],
  },
  {
    id: "complexity-boundary", group: "routing", title: "complexity boundary: 240 vs 241 chars", expect: "tier A → tier B flip",
    blurb: "Same question, one char apart across the complexity line — routing is deterministic and citable.",
    run: async (f) => {
      const base = "please summarize the refund policy, limits, and processing times for a marketplace seller account holder ";
      const a = await f.stream("240 chars → simple", { message: (base + "thanks").slice(0, 240).padEnd(240, ".") }, { path: "/v1/chat" });
      const b = await f.stream("241 chars → complex", { message: (base + "thanks x").slice(0, 241).padEnd(241, ".") }, { path: "/v1/chat" });
      return [a, b];
    },
  },
  {
    id: "refusal", group: "routing", title: "policy refusal: below the confidence floor", expect: "refused, cost 0, no model call",
    blurb: "Off-KB question lands under the refusal floor — the gateway refuses rather than guesses (routing plan = blocked_policy).",
    run: async (f) => [await f.stream("is the moon made of cheese?", { message: QUESTION_REFUSAL })],
  },
  {
    id: "weak-band", group: "routing", title: "weak retrieval → capable tier", expect: "tier B first, 'weak' label",
    blurb: "Confidence in the [0.48, 0.55) band: answered, not refused, but ambiguous enough that the stronger tier takes it.",
    run: async (f) => {
      // Pick a candidate that actually lands in the band — the band is narrow.
      const steps: Step[] = [];
      for (const q of WEAK_CANDIDATES) {
        const res = await fetch("/v1/console/demo/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
        if (!res.ok) continue;
        const p = (await res.json()) as ProbeResult;
        steps.push(f.note("probe", `${q} → confidence ${p.retrieval.confidence.toFixed(2)} (${p.verdict.weak ? "weak ✓" : "not in band"})`));
        if (p.verdict.weak) {
          steps.push(await f.stream("weak-band question", { message: q }));
          break;
        }
      }
      return steps;
    },
  },
  {
    id: "fallback-stall", group: "failure & fallback", title: "fallback: first backend stalls", expect: "timeout → tier A serves, fallback: true",
    blurb: "Mock goes first and hangs; the router's per-chunk timeout (6s) kills it and the next candidate streams.",
    run: async (f) => {
      await f.setLevers({ routingChain: "mock,openrouter-tier-a", mock: { failureMode: "hang" } });
      const steps = [await f.stream("stalled primary → fallback", { message: QUESTION_ON_KB })];
      await f.setLevers({ routingChain: "", mock: { failureMode: "none" } });
      steps.push(f.note("levers reset", "chain and mock mode returned to policy defaults"));
      return steps;
    },
  },
  {
    id: "fallback-error", group: "failure & fallback", title: "fallback: first backend errors", expect: "failed step → tier A serves",
    blurb: "Same walk, but the mock fails fast instead of hanging — the plan records failed → served.",
    run: async (f) => {
      await f.setLevers({ routingChain: "mock,openrouter-tier-a", mock: { failureMode: "fail" } });
      const steps = [await f.stream("failing primary → fallback", { message: QUESTION_ON_KB })];
      await f.setLevers({ routingChain: "", mock: { failureMode: "none" } });
      steps.push(f.note("levers reset", "chain and mock mode returned to policy defaults"));
      return steps;
    },
  },
  {
    id: "midstream", group: "failure & fallback", title: "mid-stream fault: no re-routing", expect: "partial answer, then error event",
    blurb: "The backend dies AFTER the first byte: the answer is never spliced or re-routed — a visible error is correct, a spliced one would be correct-looking and wrong.",
    run: async (f) => {
      await f.setLevers({ routingChain: "mock,openrouter-tier-a", mock: { failureMode: "midstream" } });
      const steps = [await f.stream("dies mid-answer", { message: QUESTION_ON_KB })];
      await f.setLevers({ routingChain: "", mock: { failureMode: "none" } });
      steps.push(f.note("levers reset", "chain and mock mode returned to policy defaults"));
      return steps;
    },
  },
  {
    id: "unusable", group: "failure & fallback", title: "unusable output → refusal", expect: "refused ('unusable'), tokens kept off quota",
    blurb: "The model 'answers' with 2 characters: served-looking, but the route layer converts it to the unusable-output refusal.",
    run: async (f) => {
      await f.setLevers({ routingChain: "mock,openrouter-tier-a", mock: { failureMode: "short" } });
      const steps = [await f.stream("2-char answer", { message: QUESTION_ON_KB })];
      await f.setLevers({ routingChain: "", mock: { failureMode: "none" } });
      steps.push(f.note("billing note", "tokens + cost hit the requests row (USD budget counts them); request/token counters are not bumped"));
      return steps;
    },
  },
  {
    id: "total-failure", group: "failure & fallback", title: "total failure: every candidate down", expect: "502 backend_unavailable + full plan",
    blurb: "Fault injection marks all three backends dead — the walker exhausts the plan and returns a structured 502, never a hang.",
    run: async (f) => {
      await f.setLevers({ faults: { "openrouter-tier-a": "dead", "openrouter-tier-b": "dead", mock: "dead" } });
      const steps = [await f.http("all backends dead", { message: QUESTION_ON_KB })];
      await f.setLevers({ faults: { "openrouter-tier-a": "healthy", "openrouter-tier-b": "healthy", mock: "healthy" } });
      steps.push(f.note("faults cleared", "all backends healthy again"));
      return steps;
    },
  },
  {
    id: "quota-requests", group: "quota", title: "quota: requests exceeded", expect: "first ok, second 429",
    blurb: "Caps your own tenant to (used + 1) requests, fires twice — the second is denied with the limit, usage and reset in the body. Then restores the real limit.",
    run: async (f) => {
      const prev = await f.setTenant({ requestsPerDay: f.used.requestCount + 1 });
      const steps = [await f.stream("first request — under cap", { message: QUESTION_ON_KB }), await f.http("second request — over cap", { message: QUESTION_ON_KB })];
      await f.setTenant({ requestsPerDay: prev.previous?.requestsPerDay ?? 200 });
      steps.push(f.note("limit restored", `${prev.previous?.requestsPerDay ?? 200} requests/day restored for your tenant`));
      return steps;
    },
  },
  {
    id: "quota-budget", group: "quota", title: "quota: USD budget exhausted", expect: "429 with budget reason",
    blurb: "Drops your tenant's daily budget to half of what was already spent today — the next request is denied in the spend currency.",
    run: async (f) => {
      if (f.used.usdSpend <= 0) {
        return [f.note("no spend today", "fire a normal request first (e.g. the refusal scene consumes budget only when the model is called), then rerun")];
      }
      const prev = await f.setTenant({ budgetUsdPerDay: Math.max(f.used.usdSpend / 2, 0.0001) });
      const steps = [await f.http("over the budget", { message: QUESTION_ON_KB })];
      await f.setTenant({ budgetUsdPerDay: prev.previous?.budgetUsdPerDay ?? 0.7 });
      steps.push(f.note("limit restored", `$${prev.previous?.budgetUsdPerDay ?? 0.7}/day restored for your tenant`));
      return steps;
    },
  },
];