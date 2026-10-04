import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "./ui/chart";
import { cn, usd } from "../lib/utils";
import { useApiList, type SeriesData } from "./log-explorer";

/**
 * Usage charts, on shadcn's chart wrapper (recharts underneath — the one chart
 * system on the console). Bars again: the buckets are discrete metering sums,
 * they stack into a comparable total, and traffic gaps should read as gaps.
 *
 * One chart body, two surfaces: <UsageChart> on /observability (turns, with
 * metric + window toggles) and <LogChart> at the top of each see-all page —
 * fed that page's domain AND its current filters, so the picture and the table
 * always agree.
 */

/** Muted hues, matched to the badge accents; assigned per series in config order. */
const PALETTE = [
  "oklch(0.765 0.177 163.223)", // emerald-400
  "oklch(0.707 0.165 254.624)", // blue-400
  "oklch(0.702 0.183 293.541)", // violet-400
  "oklch(0.828 0.189 84.429)", // amber-400
  "oklch(0.712 0.194 13.428)", // rose-400
  "oklch(0.777 0.152 181.912)", // teal-400
];

const METRIC_LABELS: Record<string, string> = {
  requests: "requests",
  tokens: "tokens",
  costUsd: "cost",
  fallbacks: "fallbacks fired",
  sessions: "sessions created",
};

type SeriesResponse = SeriesData;

/** The stacked-bar body shared by every chart on the observability surface. */
function StackedBars({ data, className }: { data: SeriesData; className?: string }): React.ReactElement {
  const config: ChartConfig = Object.fromEntries(
    data.series.map((t, i) => [t.tenant, { label: t.tenant, color: PALETTE[i % PALETTE.length] }]),
  );
  // one row per bucket; a column per tenant, for recharts to stack
  const rows = data.buckets.map((b, i) => {
    const row: Record<string, string | number> = { bucket: bucketLabel(b, data.bucketKind ?? "time") };
    for (const t of data.series) row[t.tenant] = t.values[i] ?? 0;
    return row;
  });
  const fmtY = metricFormat(data.metric);

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-[220px] w-full", className)}>
      <BarChart data={rows} margin={{ left: 4, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bucket"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(v: string) => (data.bucketKind === "category" ? v.slice(0, 14) : v)}
        />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={fmtY} />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(label) => String(label)} />}
          cursor={{ fill: "var(--muted)", fillOpacity: 0.35 }}
        />
        <ChartLegend content={<ChartLegendContent />} />
        {/* stackId="s" makes the tenants one bar per bucket; the rounded crown
            goes on the top series of the stack */}
        {data.series.map((t, i) => (
          <Bar
            key={t.tenant}
            dataKey={t.tenant}
            stackId="s"
            fill={`var(--color-${t.tenant})`}
            radius={i === data.series.length - 1 ? [3, 3, 0, 0] : 0}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

export function UsageChart(): React.ReactElement {
  const [metric, setMetric] = useState("requests");
  const [span, setSpan] = useState("24h");
  const { data, error, loading } = useApiList<SeriesResponse>(
    `/v1/console/observability/series?domain=turns&metric=${metric}&window=${span}`,
  );

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">usage over time</p>
          <p className="text-xs text-muted-foreground">
            {METRIC_LABELS[metric] ?? metric} · stacked per tenant · utc
            {data ? ` · ${chartTotal(data)} over the window` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {["requests", "tokens", "costUsd"].map((m) => (
            <Toggle key={m} active={metric === m} onClick={() => setMetric(m)}>{METRIC_LABELS[m]!}</Toggle>
          ))}
          <span className="mx-1 text-border">|</span>
          <Toggle active={span === "24h"} onClick={() => setSpan("24h")}>24h hourly</Toggle>
          <Toggle active={span === "30d"} onClick={() => setSpan("30d")}>30 days daily</Toggle>
        </div>
      </div>

      <ChartState error={error} loading={loading} data={data} />
    </Card>
  );
}

/** A page's chart: that domain's meters over time (or top keys for /keys),
    shaped by whatever the toolbar above the table is filtering on. */
export function LogChart({
  domain,
  metrics,
  filters,
  note,
}: {
  domain: "turns" | "sessions" | "decisions" | "keys";
  metrics: { key: string; label: string }[];
  filters: Record<string, string | number>;
  note?: string;
}): React.ReactElement {
  const categorical = domain === "keys";
  const [metric, setMetric] = useState(metrics[0]!.key);
  const [span, setSpan] = useState("24h");

  const sp = new URLSearchParams({ domain, metric: metric });
  if (!categorical) sp.set("window", span);
  for (const [k, v] of Object.entries(filters)) {
    if (v !== "" && v !== 0) sp.set(k, String(v));
  }
  const { data, error, loading } = useApiList<SeriesResponse>(`/v1/console/observability/series?${sp}`);

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">
            {METRIC_LABELS[metric] ?? metric} {categorical ? "by key (today)" : "over time"}
          </p>
          <p className="text-xs text-muted-foreground">
            {note ?? "follows the filters above the table"}
            {data ? ` · ${chartTotal(data)}${categorical ? "" : " over the window"}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {metrics.map((m) => (
            <Toggle key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>{m.label}</Toggle>
          ))}
          {!categorical && (
            <>
              <span className="mx-1 text-border">|</span>
              <Toggle active={span === "24h"} onClick={() => setSpan("24h")}>24h hourly</Toggle>
              <Toggle active={span === "30d"} onClick={() => setSpan("30d")}>30 days daily</Toggle>
            </>
          )}
        </div>
      </div>

      <ChartState error={error} loading={loading} data={data} />
    </Card>
  );
}

/** Shared toggles / states / formatters */

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className={cn("h-7 px-2.5 text-xs", !active && "text-muted-foreground")}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ChartState({ error, loading, data }: { error: string | null; loading: boolean; data: SeriesResponse | null }): React.ReactElement {
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (loading) return <div className="h-[220px] animate-pulse rounded-lg bg-muted/50" />;
  if (!data || data.buckets.length === 0) {
    return <p className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">nothing in this window</p>;
  }
  const flat = data.series.every((s) => s.values.every((v) => v === 0));
  if (flat) {
    return <p className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">no {METRIC_LABELS[data.metric] ?? data.metric} in this window</p>;
  }
  return <StackedBars data={data} />;
}

function chartTotal(data: SeriesData): string {
  return metricFormat(data.metric)(data.total);
}

function metricFormat(metric: string): (v: number) => string {
  if (metric === "costUsd") return (v) => usd(v);
  return (v) =>
    v >= 10_000 ? `${(v / 1000).toFixed(0)}k`
    : v >= 1000 ? `${(v / 1000).toFixed(1)}k`
    : String(Math.round(v));
}

/** Bucket keys sort as text; the display keeps only what the axis needs. */
function bucketLabel(bucket: string, kind: "time" | "category"): string {
  if (kind === "category") return bucket.slice(0, 18);
  return bucket.length === 13 ? bucket.slice(11, 13) + ":00" : bucket.slice(5, 10);
}