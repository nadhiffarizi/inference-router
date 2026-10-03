import { useEffect, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Card, CardContent } from "./components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "./components/ui/table";
import { outcomeBadge } from "./lib/badges";
import { usd } from "./lib/utils";

/**
 * The product team's own slice of observability: today's requests, tokens and
 * spend, remaining quota (requests + USD budget), totals, and the last 15
 * routing decisions for THIS tenant only — server-scoped to the session.
 */

type OwnTenantUsage = {
  tenant: { id: number; name: string };
  today: { requests: number; tokens: number; costsUsd: number; day: string };
  quota: { requestsPerDay: number; tokensPerDay: number; budgetUsdPerDay: number };
  remaining: { requests: number; tokens: number; budgetUsd: number };
  totals: { requests: number; costUsd: number };
  keyUsage?: { label: string; maskedKey: string | null; requests: number; tokens: number; costUsd: number }[];
  decisions: {
    requestId: string;
    capability: string;
    plan: { backendId: string; action: string; reason: string }[];
    chosenBackendId: string | null;
    fallbackTriggered: boolean;
    createdAt: string;
  }[];
};

export function UsageView(): React.ReactElement {
  const [data, setData] = useState<OwnTenantUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/v1/console/usage")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as OwnTenantUsage;
      })
      .then((d) => alive && setData(d))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Notice tone="muted">loading…</Notice>;

  return (
    <div className="mx-auto max-w-4xl space-y-5 pt-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="requests today" value={String(data.today.requests)} sub={`of ${data.quota.requestsPerDay}`} />
        <Stat label="spend today" value={usd(data.today.costsUsd)} sub={`of $${data.quota.budgetUsdPerDay.toFixed(2)}`} highlight={data.remaining.budgetUsd === 0} />
        <Stat label="remaining today" value={usd(data.remaining.budgetUsd)} sub={`${data.remaining.requests} requests · ${data.remaining.tokens} tokens`} />
      </div>

      {data.keyUsage && data.keyUsage.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Per key (today)</h2>
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>key name</TableHead>
                  <TableHead>key</TableHead>
                  <TableHead className="text-right">requests</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-right">spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.keyUsage.map((k) => (
                  <TableRow key={`${k.label}-${k.maskedKey ?? ""}`}>
                    <TableCell className="font-medium">{k.label}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{k.maskedKey ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.requests}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.tokens}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(k.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </section>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-5 py-3">
            <p className="text-sm font-medium">routing decisions — own requests, latest {data.decisions.length}</p>
            <Badge variant="secondary">{data.tenant.name}</Badge>
          </div>
          {data.decisions.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-muted-foreground">Nothing routed yet — use the playground.</p>
          ) : (
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function Stat({ label, value, sub, highlight }: { label: string; value: string; sub: string; highlight?: boolean }): React.ReactElement {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-semibold tabular-nums${highlight ? " text-destructive" : ""}`}>{value}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

function Notice({ tone, children }: { tone: "error" | "muted"; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mx-auto max-w-4xl pt-5">
      <Card className={tone === "error" ? "border-destructive/40" : ""}>
        <CardContent className={`p-4 text-sm ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>{children}</CardContent>
      </Card>
    </div>
  );
}