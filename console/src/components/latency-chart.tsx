import { useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { Card } from "./ui/card";
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "./ui/chart";
import { bucketAxisLabel, bucketTooltipLabel, browserZone } from "../lib/time";
import { useApiList, type SeriesData } from "./log-explorer";
import { PALETTE, Toggle } from "./usage-chart";

/**
 * Latency charts. Lines, not bars: latency is a level, not a sum — stacking
 * percentiles means nothing, and the shape the eye should trace is "did the
 * tail move". Gaps (buckets with no qualifying rows, null from the API) are
 * skipped by the line, never drawn as 0 ms of latency.
 *
 * The dashed lines are starting service-level targets, not measurements: a
 * bucket above a target reads as "one turn in twenty felt slower than
 * promised". They are constants, deliberately unedited in the UI until a
 * target is per-capability and agreed (retrieval-augmented support turns are
 * structurally slower than plain chat).
 */

/** End-to-end SLO line (p95) — ms from request start, streaming included. */
const LATENCY_TARGET_MS = 400;
/** Streaming targets for the /observability/activity card: first token and
    per-token decode budget of 200 ms each; the throughput floor below is
    simply that same 200 ms/token in units that chart can show. */
const TTFT_TARGET_MS = 200;
const TPOT_TARGET_MS = 200;
const TPS_FLOOR_TPS = 5;

type LatencyMetric = "latencyP95" | "ttftP95" | "tpotP95" | "tpsP50";

const METRICS: Record<LatencyMetric, { title: string; targetAt: number; targetLabel: string; unit: string; unitSub: string }> = {
  latencyP95: { title: "p95 latency over time", targetAt: LATENCY_TARGET_MS, targetLabel: `target ${LATENCY_TARGET_MS} ms`, unit: "ms", unitSub: "ms" },
  ttftP95: { title: "time to first token — p95 over time", targetAt: TTFT_TARGET_MS, targetLabel: `target ${TTFT_TARGET_MS} ms`, unit: "ms", unitSub: "ms" },
  tpotP95: { title: "time per output token — p95 over time", targetAt: TPOT_TARGET_MS, targetLabel: `target ${TPOT_TARGET_MS} ms/token`, unit: "ms/token", unitSub: "ms/token" },
  tpsP50: { title: "generation throughput — median over time", targetAt: TPS_FLOOR_TPS, targetLabel: `floor ${TPS_FLOOR_TPS} tok/s (= ${TPOT_TARGET_MS} ms/token)`, unit: "tok/s", unitSub: "tok/s median" },
};

/** The two surfaces: the home card keeps fleet-level SLO p95; the activity
    page gets the streaming shape (TTFT / TPOT / throughput), filterable by
    whatever the toolbar above its table is filtering on. */

export function LatencyChart(): React.ReactElement {
  return <LatencyCard metric="latencyP95" />;
}

export function StreamingLatencyCard({ filters }: { filters: Record<string, string | number> }): React.ReactElement {
  const [metric, setMetric] = useState<LatencyMetric>("ttftP95");
  return <LatencyCard metric={metric} onMetric={setMetric} metrics={["ttftP95", "tpotP95", "tpsP50"]} filters={filters} />;
}

/** One chart body with a metric switch; the home card just never shows the switch. */
function LatencyCard({
  metric, onMetric, metrics, filters = {},
}: {
  metric: LatencyMetric;
  onMetric?: (m: LatencyMetric) => void;
  metrics?: LatencyMetric[];
  filters?: Record<string, string | number>;
}): React.ReactElement {
  const [span, setSpan] = useState("24h");
  const spec = METRICS[metric];

  const sp = new URLSearchParams({ domain: "turns", metric, window: span });
  for (const [k, v] of Object.entries(filters)) {
    if (v !== "" && v !== 0) sp.set(k, String(v));
  }
  const { data, error, loading } = useApiList<SeriesData>(`/v1/console/observability/series?${sp}`);

  const config: ChartConfig = Object.fromEntries(
    (data?.series ?? []).map((t, i) => [t.tenant, { label: t.tenant, color: PALETTE[i % PALETTE.length] }]),
  );
  const rows = (data?.buckets ?? []).map((b, i) => {
    const row: Record<string, string | number | null> = {
      bucket: bucketAxisLabel(b, "time"),
      bucketAt: bucketTooltipLabel(b, "time"),
    };
    for (const t of data?.series ?? []) row[t.tenant] = t.values[i] ?? null;
    return row;
  });
  const readable = data?.series.some((t) => t.values.some((v) => v !== null)) ?? false;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{spec.title}</p>
          <p className="text-xs text-muted-foreground">
            per tenant · {browserZone()} · {spec.unitSub}
            {data && data.total > 0 ? ` · ${fmtValue(data.total, metric)} over the window` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {metrics?.map((m) => (
            <Toggle key={m} active={metric === m} onClick={() => onMetric?.(m)}>{toggleLabel(m)}</Toggle>
          ))}
          {metrics && <span className="mx-1 text-border">|</span>}
          <Toggle active={span === "24h"} onClick={() => setSpan("24h")}>24h hourly</Toggle>
          <Toggle active={span === "30d"} onClick={() => setSpan("30d")}>30 days daily</Toggle>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : loading ? (
        <div className="h-[220px] animate-pulse rounded-lg bg-muted/50" />
      ) : !data || data.buckets.length === 0 || !readable ? (
        <p className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
          no readable samples in this window
        </p>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
          <LineChart data={rows} margin={{ left: 4, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(v: number) => fmtTick(v, spec.unit)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    String((payload?.[0]?.payload as { bucketAt?: string } | undefined)?.bucketAt ?? "")
                  }
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            {/* the target rides with the data — see the header block for what missing it means */}
            <ReferenceLine
              y={spec.targetAt}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              label={{ value: spec.targetLabel, position: "insideTopRight", fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            {(data?.series ?? []).map((t) => (
              <Line
                key={t.tenant}
                type="monotone"
                dataKey={t.tenant}
                stroke={`var(--color-${t.tenant})`}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ChartContainer>
      )}
    </Card>
  );
}

function toggleLabel(metric: LatencyMetric): string {
  return { latencyP95: "p95", ttftP95: "ttft p95", tpotP95: "tpot p95", tpsP50: "tokens/s median" }[metric];
}

function fmtValue(v: number, metric: LatencyMetric): string {
  if (metric === "tpsP50") return `${v.toFixed(1)} tok/s`;
  if (metric === "tpotP95") return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ms/token`;
  return `${v >= 1000 ? Math.round(v).toLocaleString() : Math.round(v)} ms`;
}

function fmtTick(v: number, unit: string): string {
  if (unit === "tok/s") return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} t/s`;
  return `${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v)} ms`;
}