import { useEffect, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Card } from "./components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "./components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "./components/ui/table";
import { outcomeBadge } from "./lib/badges";
import { usd } from "./lib/utils";
import { Stat } from "./usage";
import { Bubble } from "./lib/chatui";
import { fetchSessionTimeline, type Turn } from "./api";

/**
 * Admin-only cross-tenant view: usage for every tenant plus the routing
 * decision log. Server-enforced (/v1/console/observability → 403 for product).
 */

type TraceEntry = { id: number; question: string; answer: string; intent: string };

type ActivityRow = {
  id: string;
  createdAt: string;
  tenant: string;
  capability: string;
  keyLabel: string | null;
  backendId: string;
  modelId: string;
  tokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: string;
  question: string | null;
  answer: string | null;
  retrievalConfidence: number | null;
  retrieval: TraceEntry[] | null;
  intent: string | null;
  error: string | null;
};

type SessionRow = {
  uid: number;
  tenantName: string;
  externalId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  turns: number;
  spendUsd: number;
};

type Observability = {
  tenants: {
    tenant: { id: number; name: string };
    today: { requests: number; tokens: number; costsUsd: number };
    quota: { requestsPerDay: number; tokensPerDay: number; budgetUsdPerDay: number };
    remaining: { requests: number; tokens: number; budgetUsd: number };
    totals: { requests: number; costUsd: number };
  }[];
  keys?: { tenant: string; label: string; maskedKey: string | null; requests: number; tokens: number; costUsd: number }[];
  activity?: ActivityRow[];
  sessions?: SessionRow[];
  decisions: {
    requestId: string;
    tenantId: number;
    capability: string;
    plan: { backendId: string; action: string; reason: string }[];
    chosenBackendId: string | null;
    fallbackTriggered: boolean;
    createdAt: string;
  }[];
};

export function ObservabilityView(): React.ReactElement {
  const [data, setData] = useState<Observability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTrace, setOpenTrace] = useState<ActivityRow | null>(null);
  const [openSessionUid, setOpenSessionUid] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/v1/console/observability")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Observability;
      })
      .then((d) => alive && setData(d))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-6xl pt-5">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (!data) return <p className="pt-5 text-sm text-muted-foreground">loading…</p>;

  const fleetSpend = data.tenants.reduce((s, t) => s + t.today.costsUsd, 0);
  const fleetRequests = data.tenants.reduce((s, t) => s + t.today.requests, 0);
  const fallbackFires = data.decisions.filter((d) => d.fallbackTriggered).length;

  return (
    <div className="mx-auto max-w-6xl space-y-5 pt-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="fleet requests today" value={String(fleetRequests)} sub="all tenants" />
        <Stat label="fleet spend today" value={usd(fleetSpend)} sub="all tenants, USD budget enforced" />
        <Stat label="fallback fired (last 25)" value={String(fallbackFires)} sub="routing decisions" />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Tenants</h2>
        <Card className="overflow-hidden hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>tenant</TableHead>
                <TableHead className="text-right">requests today</TableHead>
                <TableHead className="text-right">spend today</TableHead>
                <TableHead className="text-right">budget left</TableHead>
                <TableHead className="text-right">total cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.tenants.map((t) => (
                <TableRow key={t.tenant.id}>
                  <TableCell className="font-medium">{t.tenant.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.today.requests}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(t.today.costsUsd)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{usd(t.remaining.budgetUsd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(t.totals.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        {/* mobile stacked cards — design.md: no horizontal-scroll-only tables */}
        <div className="grid gap-3 md:hidden">
          {data.tenants.map((t) => (
            <div key={t.tenant.id} className="rounded-xl border p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium">{t.tenant.name}</p>
                <Badge variant="secondary">{t.today.requests} today</Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                spend {usd(t.today.costsUsd)} · left {usd(t.remaining.budgetUsd)} · {t.remaining.requests} requests
              </p>
            </div>
          ))}
        </div>
      </section>

      {data.keys && data.keys.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Per key (today, all tenants)</h2>
          <Card className="overflow-hidden hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>tenant</TableHead>
                  <TableHead>key name</TableHead>
                  <TableHead className="text-right">requests</TableHead>
                  <TableHead className="text-right">spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.keys.map((k) => (
                  <TableRow key={`${k.tenant}-${k.label}`}>
                    <TableCell className="font-medium">{k.tenant}</TableCell>
                    <TableCell>
                      {k.label}
                      {k.maskedKey && <span className="ml-2 font-mono text-xs text-muted-foreground">{k.maskedKey}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{k.requests}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(k.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <div className="grid gap-3 md:hidden">
            {data.keys.map((k) => (
              <div key={`${k.tenant}-${k.label}`} className="rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{k.label}</p>
                  <Badge variant="secondary">{k.requests} req</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{k.tenant} · {usd(k.costUsd)}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.activity && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Activity — gateway calls (latest {data.activity.length})</h2>
          <Card className="overflow-hidden hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>time (utc)</TableHead>
                  <TableHead>tenant</TableHead>
                  <TableHead>capability</TableHead>
                  <TableHead>key</TableHead>
                  <TableHead>model</TableHead>
                  <TableHead>outcome</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-right">cost</TableHead>
                  <TableHead className="text-right">latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.activity.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setOpenTrace(r)}
                  >
                    <TableCell className="whitespace-nowrap font-mono text-xs">{r.createdAt.slice(11, 19)}</TableCell>
                    <TableCell>{r.tenant}</TableCell>
                    <TableCell>
                      <Badge variant={r.capability === "support-assistant" ? "info" : "secondary"}>
                        {r.capability === "support-assistant" ? "assistant" : "chat"}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-32 truncate text-xs">{r.keyLabel ?? "—"}</TableCell>
                    <TableCell className="max-w-44 truncate font-mono text-xs">{r.modelId}</TableCell>
                    <TableCell><Badge variant={outcomeBadge(r.outcome)}>{r.outcome}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{r.tokens}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(r.costUsd)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.latencyMs} ms</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* mobile: clickable stacked cards */}
          <div className="grid gap-3 md:hidden">
            {data.activity.map((r) => (
              <button key={r.id} onClick={() => setOpenTrace(r)} className="rounded-xl border p-4 text-left">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{r.createdAt.slice(11, 19)}</span>
                  <Badge variant={outcomeBadge(r.outcome)}>{r.outcome}</Badge>
                </div>
                <p className="mt-1 truncate text-sm">{r.question ?? "(no trace)"}</p>
                <p className="text-xs text-muted-foreground">
                  {r.tenant} · {r.modelId} · {usd(r.costUsd)} · {r.latencyMs} ms
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      {data.sessions && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Chat sessions — every tenant, soft-deleted included</h2>
          <Card className="overflow-hidden hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>session (first question)</TableHead>
                  <TableHead>tenant</TableHead>
                  <TableHead>caller id</TableHead>
                  <TableHead className="text-right">turns</TableHead>
                  <TableHead className="text-right">spend</TableHead>
                  <TableHead>last activity (utc)</TableHead>
                  <TableHead>state</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sessions.map((sess) => (
                  <TableRow key={sess.uid} className="cursor-pointer" onClick={() => setOpenSessionUid(sess.uid)}>
                    <TableCell className="max-w-64 truncate font-medium">{sess.title}</TableCell>
                    <TableCell>{sess.tenantName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{sess.externalId.slice(0, 18)}</TableCell>
                    <TableCell className="text-right tabular-nums">{sess.turns}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(sess.spendUsd)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{sess.updatedAt.slice(11, 19)}</TableCell>
                    <TableCell>{sess.deletedAt ? <Badge variant="secondary">deleted (soft)</Badge> : <Badge variant="success">active</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <div className="grid gap-3 md:hidden">
            {data.sessions.map((sess) => (
              <button key={sess.uid} onClick={() => setOpenSessionUid(sess.uid)} className="rounded-xl border p-3 text-left">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium">{sess.title}</p>
                  {sess.deletedAt ? <Badge variant="secondary">deleted</Badge> : <Badge variant="success">active</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {sess.tenantName} · {sess.turns} turns · {usd(sess.spendUsd)}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Routing decisions (latest 25, all tenants)</h2>
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>request</TableHead>
                <TableHead>capability</TableHead>
                <TableHead>served by</TableHead>
                <TableHead>fallback</TableHead>
                <TableHead className="hidden sm:table-cell">plan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.decisions.map((d) => (
                <TableRow key={d.requestId}>
                  <TableCell className="font-mono text-xs">{d.requestId.slice(0, 8)}</TableCell>
                  <TableCell>
                    <Badge variant={d.capability === "support-assistant" ? "info" : "secondary"}>{d.capability}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{d.chosenBackendId ?? "—"}</TableCell>
                  <TableCell>
                    {d.fallbackTriggered ? <Badge variant="warning">fired</Badge> : <Badge variant="secondary">—</Badge>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <ol className="space-y-0.5">
                      {d.plan.map((s, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs">
                          <Badge variant={outcomeBadge(s.action)}>{s.action}</Badge>
                          <span className="font-mono">{s.backendId}</span>
                        </li>
                      ))}
                    </ol>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      <TraceDialog trace={openTrace} plan={openTrace ? data.decisions.find((d) => d.requestId === openTrace.id)?.plan ?? null : null} onClose={() => setOpenTrace(null)} />
      <SessionDialog uid={openSessionUid} onClose={() => setOpenSessionUid(null)} />
    </div>
  );
}

/** Session timeline (Langfuse session view): turns in order, full trace on each. */
function SessionDialog({ uid, onClose }: { uid: number | null; onClose: () => void }): React.ReactElement {
  const [timeline, setTimeline] = useState<{ title: string; turns: Turn[] } | null>(null);

  useEffect(() => {
    let alive = true;
    setTimeline(null);
    if (uid === null) return;
    fetchSessionTimeline(uid, true).then((t) => {
      if (!alive || !t) return;
      setTimeline({ title: t.session.title, turns: t.turns });
    });
    return () => {
      alive = false;
    };
  }, [uid]);

  return (
    <Dialog open={uid !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{timeline ? timeline.title : "session"}</DialogTitle>
        </DialogHeader>
        {timeline === null ? (
          <p className="text-sm text-muted-foreground">loading…</p>
        ) : (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto">
            {timeline.turns.map((t) => (
              <div key={t.id} className="rounded-lg border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">{t.createdAt.slice(11, 19)} UTC</span>
                  <Badge variant={outcomeBadge(t.outcome)}>{t.outcome}</Badge>
                  {t.intent && <Badge variant="success">{t.intent}</Badge>}
                  <Badge variant="outline" className="font-mono text-[10px]">{t.backendId} · {t.modelId.split("/").pop()}</Badge>
                  <Badge variant="secondary" className="text-[10px]">{t.keyLabel ?? "—"}</Badge>
                  <span className="ml-auto text-[10px] text-muted-foreground">{usd(t.costUsd)} · {t.latencyMs} ms</span>
                </div>
                <div className="space-y-2">
                  <Bubble role="user">{t.question ?? "(not recorded)"}</Bubble>
                  {t.answer ? <Bubble role="assistant">{t.answer}</Bubble> : t.error ? <Bubble role="assistant" tone="error">{t.error}</Bubble> : null}
                </div>
                {t.retrieval && t.retrieval.length > 0 && (
                  <p className="mt-2 truncate text-[10px] text-muted-foreground">
                    retrieved: {t.retrieval.map((e) => e.intent).join(", ")} · confidence {t.retrievalConfidence?.toFixed(2)}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Langfuse-mini: the stored chat turn — question, answer, what was retrieved,
 * how it was routed, what it cost. One dialog per activity row.
 */
function TraceDialog({ trace, plan, onClose }: { trace: ActivityRow | null; plan: Observability["decisions"][number]["plan"] | null; onClose: () => void }): React.ReactElement {
  return (
    <Dialog open={trace !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        {trace && (
          <>
            <DialogHeader>
              <DialogTitle>trace · {trace.createdAt.slice(0, 19).replace("T", " ")} UTC</DialogTitle>
            </DialogHeader>

            {/* summary badges */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={outcomeBadge(trace.outcome)}>{trace.outcome}</Badge>
              <Badge variant={trace.capability === "support-assistant" ? "info" : "secondary"}>{trace.capability}</Badge>
              <Badge variant="outline" className="font-mono">{trace.backendId}</Badge>
              <Badge variant="outline" className="font-mono text-[10px]">{trace.modelId}</Badge>
              {trace.keyLabel && <Badge variant="secondary">{trace.keyLabel}</Badge>}
              {trace.intent && <Badge variant="success">{trace.intent}</Badge>}
            </div>

            {/* the turn */}
            <div className="space-y-3">
              <Bubble role="user">{trace.question ?? "(not recorded)"}</Bubble>
              {trace.answer !== null && trace.answer.length > 0 ? (
                <Bubble role="assistant">{trace.answer}</Bubble>
              ) : trace.error ? (
                <Bubble role="assistant" tone="error">{trace.error}</Bubble>
              ) : (
                <Bubble role="assistant" tone="warning">(no answer recorded — refused or failed before generation)</Bubble>
              )}
            </div>

            {/* retrieval trace */}
            {trace.retrieval && trace.retrieval.length > 0 && (
              <div className="rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  retrieved {trace.retrieval.length} entries
                  {trace.retrievalConfidence !== null ? ` · confidence ${trace.retrievalConfidence.toFixed(2)}` : ""}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {trace.retrieval.map((e) => (
                    <li key={e.id} className="truncate text-xs text-muted-foreground">
                      <Badge variant="outline" className="mr-1.5 text-[10px]">{e.intent}</Badge>
                      {e.question.slice(0, 70)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* routing plan */}
            {plan && (
              <div className="rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground">routing plan</p>
                <ol className="mt-2 space-y-1">
                  {plan.map((s, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs">
                      <Badge variant={outcomeBadge(s.action)}>{s.action}</Badge>
                      <span className="font-mono">{s.backendId}</span>
                      <span className="text-muted-foreground">{s.reason}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* metering */}
            <div className="grid grid-cols-4 gap-2 rounded-lg border p-3">
              <div><p className="text-[10px] text-muted-foreground">tokens</p><p className="font-mono text-sm font-semibold">{trace.tokens}</p></div>
              <div><p className="text-[10px] text-muted-foreground">cost</p><p className="font-mono text-sm font-semibold">{usd(trace.costUsd)}</p></div>
              <div><p className="text-[10px] text-muted-foreground">latency</p><p className="font-mono text-sm font-semibold">{trace.latencyMs} ms</p></div>
              <div><p className="text-[10px] text-muted-foreground">request</p><p className="font-mono text-sm font-semibold">{trace.id.slice(0, 8)}</p></div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
