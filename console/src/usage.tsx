import { useEffect, useState } from "react";
import { fetchUsage, type UsageResponse } from "./api";
import { Badge } from "./components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Select } from "./components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "./components/ui/table";
import { outcomeBadge } from "./lib/badges";
import { usd } from "./lib/utils";

/**
 * Usage: per-tenant requests/cost/quota (tables on desktop; per design.md,
 * tables collapse to stacked cards below md), plus the routing decision log
 * — the brief's "decision recorded and inspectable", rendered.
 */

export function UsageView({ apiKey }: { apiKey: string }): React.ReactElement {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(25);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchUsage(apiKey)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [apiKey]);

  if (error) {
    return (
      <div className="mx-auto max-w-6xl pt-5">
        <Card className="border-destructive/40">
          <CardContent className="p-4">
            <Badge variant="destructive">error</Badge>
            <p className="mt-2 text-sm">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!data) return <p className="pt-5 text-sm text-muted-foreground">{loading ? "loading…" : ""}</p>;

  return (
    <div className="mx-auto max-w-6xl space-y-6 pt-5">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Tenants</h2>

        {/* desktop table */}
        <Card className="hidden overflow-hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>tenant</TableHead>
                <TableHead className="text-right">requests today</TableHead>
                <TableHead className="text-right">tokens today</TableHead>
                <TableHead className="text-right">cost today</TableHead>
                <TableHead className="text-right">remaining quota</TableHead>
                <TableHead className="text-right">total cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.tenants.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.today.requests}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.today.tokens}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(t.today.costsUsd)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {t.remaining.requests} req · {t.remaining.tokens} tok
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{usd(t.totals.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        {/* mobile stacked cards */}
        <div className="grid gap-3 md:hidden">
          {data.tenants.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{t.name}</p>
                  <Badge variant="secondary">{t.today.requests} today</Badge>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <p className="text-lg font-semibold tabular-nums">{t.today.tokens}</p>
                  <p className="text-lg font-semibold tabular-nums">{usd(t.today.costsUsd)}</p>
                  <p className="text-lg font-semibold tabular-nums text-muted-foreground">{t.remaining.requests}</p>
                  <p className="text-[10px] text-muted-foreground">tokens</p>
                  <p className="text-[10px] text-muted-foreground">cost</p>
                  <p className="text-[10px] text-muted-foreground">remaining</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">Routing decisions</h2>
          <Select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="h-8 w-28 text-xs"
            aria-label="decisions shown"
          >
            <option value="10">last 10</option>
            <option value="25">last 25</option>
            <option value="50">last 50</option>
          </Select>
        </div>
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
              {data.recentRoutingDecisions.slice(0, limit).map((d) => (
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