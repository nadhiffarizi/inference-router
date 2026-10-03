import { useEffect, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Card } from "./components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "./components/ui/table";
import { outcomeBadge } from "./lib/badges";
import { usd } from "./lib/utils";
import { Stat } from "./usage";

/**
 * Admin-only cross-tenant view: usage for every tenant plus the routing
 * decision log. Server-enforced (/v1/console/observability → 403 for product).
 */

type Observability = {
  tenants: {
    tenant: { id: number; name: string };
    today: { requests: number; tokens: number; costsUsd: number };
    quota: { requestsPerDay: number; tokensPerDay: number; budgetUsdPerDay: number };
    remaining: { requests: number; tokens: number; budgetUsd: number };
    totals: { requests: number; costUsd: number };
  }[];
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
    </div>
  );
}