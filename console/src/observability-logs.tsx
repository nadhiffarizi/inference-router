import { useEffect, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Card } from "./components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "./components/ui/table";
import {
  DateRangeFilter, FilterSelect, LogShell, Pager, SearchBox, useApiList, useDebounced, type Paged,
} from "./components/log-explorer";
import { TraceSheet, SessionSheet } from "./components/trace-drawers";
import type { TracePayload } from "./components/trace-dialog";
import { LogChart } from "./components/usage-chart";
import { LatencyChart } from "./components/latency-chart";
import { RouteChain } from "./components/route-chain";
import { outcomeBadge } from "./lib/badges";
import { usd } from "./lib/utils";
import { localStamp, localDayToIso } from "./lib/time";

/**
 * The "see all" pages behind /observability's top-K tables: same rows, minus
 * the cap, with search, filters and real pagination. Each page reads its own
 * admin endpoint and keeps its URL under /observability/*, so refresh and
 * deep links land on the same view.
 */

const PAGE_SIZE = 25;

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
  ttftMs: number | null;
  outcome: string;
  question: string | null;
  answer: string | null;
  retrievalConfidence: number | null;
  retrieval: { id: number; question: string; answer: string; intent: string }[] | null;
  intent: string | null;
  error: string | null;
  plan: { backendId: string; action: string; reason: string }[];
  fallbackTriggered: boolean;
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

type DecisionRow = {
  requestId: string;
  tenant: string;
  capability: string;
  plan: { backendId: string; action: string; reason: string }[];
  chosenBackendId: string | null;
  fallbackTriggered: boolean;
  createdAt: string;
};

type KeysRow = {
  tenant: string;
  label: string | null;
  maskedKey: string | null;
  requests: number;
  tokens: number;
  costUsd: number;
};

const TABLE_CLASSES = "overflow-hidden hidden md:block";

export function ActivityLogPage(): React.ReactElement {
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput);
  const [tenant, setTenant] = useState("");
  const [outcome, setOutcome] = useState("");
  const [capability, setCapability] = useState("");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const setRange = (from: string, to: string) => { setRangeFrom(from); setRangeTo(to); };
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [openTrace, setOpenTrace] = useState<TracePayload | null>(null);

  const url = `/v1/console/observability/activity?${buildQuery({ q, tenant, outcome, capability, from: localDayToIso(rangeFrom, "start"), to: localDayToIso(rangeTo, "end"), limit, offset })}`;
  // any filter change collapses back to page one
  useEffect(() => setOffset(0), [q, tenant, outcome, capability, rangeFrom, rangeTo, limit]);
  const { data, error, loading } = useApiList<Paged<ActivityRow>>(url);

  return (
    <LogShell title="Activity — every gateway call" sub="searchable, paginated; a row opens the chat-turn trace in a side drawer">
      <LogChart
        domain="turns"
        metrics={[
          { key: "requests", label: "requests" },
          { key: "tokens", label: "tokens" },
          { key: "costUsd", label: "cost" },
        ]}
        filters={{ q, tenant, outcome, capability, from: localDayToIso(rangeFrom, "start"), to: localDayToIso(rangeTo, "end") }}
      />
      <LatencyChart filters={{ q, tenant, outcome, capability, from: localDayToIso(rangeFrom, "start"), to: localDayToIso(rangeTo, "end") }} />
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={qInput} onChange={setQInput} placeholder="question, request id, model, key…" />
          <TenantSelect tenants={data?.facets.tenants} value={tenant} onChange={setTenant} />
          <FilterSelect value={outcome} onChange={setOutcome} options={data?.facets.outcomes ?? []} allLabel="any outcome" />
          <FilterSelect value={capability} onChange={setCapability} options={data?.facets.capabilities ?? []} allLabel="any capability" />
          <DateRangeFilter from={rangeFrom} to={rangeTo} onChange={setRange} />
          <LimitSelect value={limit} onChange={setLimit} />
        </div>
      </Card>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : loading ? (
        <p className="pt-3 text-sm text-muted-foreground">loading…</p>
      ) : (
        <>
          <Card className={TABLE_CLASSES}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>date · time (local)</TableHead>
                  <TableHead>tenant</TableHead>
                  <TableHead>capability</TableHead>
                  <TableHead>key</TableHead>
                  <TableHead>model</TableHead>
                  <TableHead>outcome</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-right">cost</TableHead>
                  <TableHead className="text-right">ttft</TableHead>
                  <TableHead className="text-right">latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.rows ?? []).map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpenTrace(r)}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{localStamp(r.createdAt)}</TableCell>
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
                    <TableCell className="text-right tabular-nums">{r.ttftMs !== null ? `${r.ttftMs} ms` : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.latencyMs} ms</TableCell>
                  </TableRow>
                ))}
                {data?.rows.length === 0 && <EmptyRow cols={10} />}
              </TableBody>
            </Table>
          </Card>

          <div className="grid gap-3 md:hidden">
            {(data?.rows ?? []).map((r) => (
              <button key={r.id} onClick={() => setOpenTrace(r)} className="rounded-xl border p-4 text-left">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{localStamp(r.createdAt)}</span>
                  <Badge variant={outcomeBadge(r.outcome)}>{r.outcome}</Badge>
                </div>
                <p className="mt-1 truncate text-sm">{r.question ?? "(no trace)"}</p>
                <p className="text-xs text-muted-foreground">
                  {r.tenant} · {r.modelId} · {usd(r.costUsd)} · ttft {r.ttftMs ?? "—"} ms · {r.latencyMs} ms
                </p>
              </button>
            ))}
          </div>

          <Card>
            <Pager total={data?.total ?? 0} limit={limit} offset={offset} onPage={setOffset} />
          </Card>
        </>
      )}

      <TraceSheet trace={openTrace} onClose={() => setOpenTrace(null)} />
    </LogShell>
  );
}

export function SessionsLogPage(): React.ReactElement {
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput);
  const [tenant, setTenant] = useState("");
  const [state, setState] = useState("");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const setRange = (from: string, to: string) => { setRangeFrom(from); setRangeTo(to); };
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [openUid, setOpenUid] = useState<number | null>(null);

  const url = `/v1/console/observability/sessions?${buildQuery({ q, tenant, state, from: localDayToIso(rangeFrom, "start"), to: localDayToIso(rangeTo, "end"), limit, offset })}`;
  useEffect(() => setOffset(0), [q, tenant, state, rangeFrom, rangeTo, limit]);
  const { data, error, loading } = useApiList<Paged<SessionRow>>(url);

  return (
    <LogShell title="Chat sessions — every tenant" sub="soft-deleted included; a row opens the session timeline in a side drawer">
      <LogChart
        domain="sessions"
        metrics={[{ key: "sessions", label: "created" }]}
        filters={{ q, tenant, state, from: localDayToIso(rangeFrom, "start"), to: localDayToIso(rangeTo, "end") }}
        note={rangeFrom || rangeTo ? "sessions created in the picked range" : "sessions created, by creation time"}
      />
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={qInput} onChange={setQInput} placeholder="first question or session_id…" />
          <TenantSelect tenants={data?.facets.tenants} value={tenant} onChange={setTenant} />
          <FilterSelect value={state} onChange={setState} options={data?.facets.state ?? []} allLabel="any state" />
          <DateRangeFilter from={rangeFrom} to={rangeTo} onChange={setRange} label="created" />
          <LimitSelect value={limit} onChange={setLimit} />
        </div>
      </Card>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : loading ? (
        <p className="pt-3 text-sm text-muted-foreground">loading…</p>
      ) : (
        <>
          <Card className={TABLE_CLASSES}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>session (first question)</TableHead>
                  <TableHead>tenant</TableHead>
                  <TableHead>session_id</TableHead>
                  <TableHead className="text-right">turns</TableHead>
                  <TableHead className="text-right">spend</TableHead>
                  <TableHead>last activity (local)</TableHead>
                  <TableHead>state</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.rows ?? []).map((sess) => (
                  <TableRow key={sess.uid} className="cursor-pointer" onClick={() => setOpenUid(sess.uid)}>
                    <TableCell className="max-w-64 truncate font-medium">{sess.title}</TableCell>
                    <TableCell>{sess.tenantName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{sess.externalId.slice(0, 18)}</TableCell>
                    <TableCell className="text-right tabular-nums">{sess.turns}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(sess.spendUsd)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{localStamp(sess.updatedAt)}</TableCell>
                    <TableCell>{sess.deletedAt ? <Badge variant="secondary">deleted (soft)</Badge> : <Badge variant="success">active</Badge>}</TableCell>
                  </TableRow>
                ))}
                {data?.rows.length === 0 && <EmptyRow cols={7} />}
              </TableBody>
            </Table>
          </Card>

          <div className="grid gap-3 md:hidden">
            {(data?.rows ?? []).map((sess) => (
              <button key={sess.uid} onClick={() => setOpenUid(sess.uid)} className="rounded-xl border p-3 text-left">
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

          <Card>
            <Pager total={data?.total ?? 0} limit={limit} offset={offset} onPage={setOffset} />
          </Card>
        </>
      )}

      <SessionSheet uid={openUid} onClose={() => setOpenUid(null)} />
    </LogShell>
  );
}

export function DecisionsLogPage(): React.ReactElement {
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput);
  const [tenant, setTenant] = useState("");
  const [capability, setCapability] = useState("");
  const [fallback, setFallback] = useState("");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const setRange = (from: string, to: string) => { setRangeFrom(from); setRangeTo(to); };
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [offset, setOffset] = useState(0);

  const url = `/v1/console/observability/decisions?${buildQuery({ q, tenant, capability, fallback, from: localDayToIso(rangeFrom, "start"), to: localDayToIso(rangeTo, "end"), limit, offset })}`;
  useEffect(() => setOffset(0), [q, tenant, capability, fallback, rangeFrom, rangeTo, limit]);
  const { data, error, loading } = useApiList<Paged<DecisionRow>>(url);

  return (
    <LogShell title="Routing decisions — every tenant" sub="the full ordered plan recorded per request, paginated">
      <LogChart
        domain="decisions"
        metrics={[
          { key: "requests", label: "decisions" },
          { key: "fallbacks", label: "fallbacks" },
        ]}
        filters={{ q, tenant, capability, fallback, from: localDayToIso(rangeFrom, "start"), to: localDayToIso(rangeTo, "end") }}
      />
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={qInput} onChange={setQInput} placeholder="request id or chosen backend…" />
          <TenantSelect tenants={data?.facets.tenants} value={tenant} onChange={setTenant} />
          <FilterSelect value={capability} onChange={setCapability} options={["chat", "support-assistant"]} allLabel="any capability" />
          <FilterSelect value={fallback} onChange={setFallback} options={data?.facets.fallback ?? []} allLabel="fallback: any" />
          <DateRangeFilter from={rangeFrom} to={rangeTo} onChange={setRange} label="decided" />
          <LimitSelect value={limit} onChange={setLimit} />
        </div>
      </Card>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : loading ? (
        <p className="pt-3 text-sm text-muted-foreground">loading…</p>
      ) : (
        <>
          <Card className={TABLE_CLASSES}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>request</TableHead>
                  <TableHead>date · time (local)</TableHead>
                  <TableHead>tenant</TableHead>
                  <TableHead>capability</TableHead>
                  <TableHead>served by</TableHead>
                  <TableHead>fallback</TableHead>
                  <TableHead className="hidden lg:table-cell">plan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.rows ?? []).map((d) => (
                  <TableRow key={d.requestId}>
                    <TableCell className="font-mono text-xs">{d.requestId.slice(0, 8)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{localStamp(d.createdAt)}</TableCell>
                    <TableCell>{d.tenant}</TableCell>
                    <TableCell>
                      <Badge variant={d.capability === "support-assistant" ? "info" : "secondary"}>{d.capability}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.chosenBackendId ?? "—"}</TableCell>
                    <TableCell>
                      {d.fallbackTriggered ? <Badge variant="warning">fired</Badge> : <Badge variant="secondary">—</Badge>}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RouteChain plan={d.plan} />
                    </TableCell>
                  </TableRow>
                ))}
                {data?.rows.length === 0 && <EmptyRow cols={7} />}
              </TableBody>
            </Table>
          </Card>

          <div className="grid gap-3 md:hidden">
            {(data?.rows ?? []).map((d) => (
              <div key={d.requestId} className="rounded-xl border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{d.requestId.slice(0, 8)}</span>
                  {d.fallbackTriggered ? <Badge variant="warning">fired</Badge> : <Badge variant="secondary">—</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {d.tenant} · {d.capability} · {d.chosenBackendId ?? "no backend"}
                </p>
              </div>
            ))}
          </div>

          <Card>
            <Pager total={data?.total ?? 0} limit={limit} offset={offset} onPage={setOffset} />
          </Card>
        </>
      )}
    </LogShell>
  );
}

export function KeysLogPage(): React.ReactElement {
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput);
  const [tenant, setTenant] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [offset, setOffset] = useState(0);

  const url = `/v1/console/observability/keys?${buildQuery({ q, tenant, limit, offset })}`;
  useEffect(() => setOffset(0), [q, tenant, limit]);
  const { data, error, loading } = useApiList<Paged<KeysRow>>(url);

  return (
    <LogShell title="Per key — today, every tenant" sub="metered by key name; keys issued and deleted both appear while they metered anything">
      <LogChart
        domain="keys"
        metrics={[
          { key: "costUsd", label: "cost" },
          { key: "requests", label: "requests" },
        ]}
        filters={{ q, tenant }}
        note="top keys by spend today, stacked per tenant"
      />
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={qInput} onChange={setQInput} placeholder="key name…" />
          <TenantSelect tenants={data?.facets.tenants} value={tenant} onChange={setTenant} />
          <LimitSelect value={limit} onChange={setLimit} />
        </div>
      </Card>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : loading ? (
        <p className="pt-3 text-sm text-muted-foreground">loading…</p>
      ) : (
        <>
          <Card className={TABLE_CLASSES}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>tenant</TableHead>
                  <TableHead>key name</TableHead>
                  <TableHead>masked key</TableHead>
                  <TableHead className="text-right">requests</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-right">spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.rows ?? []).map((k) => (
                  <TableRow key={`${k.tenant}-${k.label}`}>
                    <TableCell className="font-medium">{k.tenant}</TableCell>
                    <TableCell>{k.label ?? "unknown"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{k.maskedKey ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.requests}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.tokens}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(k.costUsd)}</TableCell>
                  </TableRow>
                ))}
                {data?.rows.length === 0 && <EmptyRow cols={6} />}
              </TableBody>
            </Table>
          </Card>

          <div className="grid gap-3 md:hidden">
            {(data?.rows ?? []).map((k) => (
              <div key={`${k.tenant}-${k.label}`} className="rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <p className="truncate font-medium">{k.label ?? "unknown"}</p>
                  <Badge variant="secondary">{k.requests} req</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{k.tenant} · {k.tokens} tokens · {usd(k.costUsd)}</p>
              </div>
            ))}
          </div>

          <Card>
            <Pager total={data?.total ?? 0} limit={limit} offset={offset} onPage={setOffset} />
          </Card>
        </>
      )}
    </LogShell>
  );
}

/** ---- shared bits ---- */

function TenantSelect({
  tenants, value, onChange,
}: {
  tenants?: string[];
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return <FilterSelect value={value} onChange={onChange} options={tenants ?? []} allLabel="all tenants" />;
}

function LimitSelect({ value, onChange }: { value: number; onChange: (v: number) => void }): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
      aria-label="rows per page"
    >
      {[10, 25, 50, 100].map((n) => (
        <option key={n} value={n}>{n} rows</option>
      ))}
    </select>
  );
}

function EmptyRow({ cols }: { cols: number }): React.ReactElement {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="py-8 text-center text-sm text-muted-foreground">
        nothing matches these filters
      </TableCell>
    </TableRow>
  );
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "" && v !== 0) sp.set(k, String(v));
  }
  return sp.toString();
}