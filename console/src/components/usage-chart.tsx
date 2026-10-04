import { useState } from "react";
import { useApiList, type SeriesData } from "./log-explorer";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { cn, usd } from "../lib/utils";

/**
 * Usage over time (Langfuse-style tracking chart): STACKED BARS, one segment
 * per tenant, one bar per time bucket. Bars suit this data — the values are
 * discrete metering counts/spend per bucket, they stack into a comparable
 * total, and gaps read as "no traffic" (a line would fake a trend between
 * unconnected buckets). Hover a segment for its exact value.
 */

const METRICS: { key: string; label: string }[] = [
  { key: "requests", label: "requests" },
  { key: "tokens", label: "tokens" },
  { key: "costUsd", label: "cost" },
];

const WINDOWS: { key: string; label: string }[] = [
  { key: "24h", label: "24h hourly" },
  { key: "30d", label: "30 days daily" },
];

/** Muted set, matched to the badge accents — tenants are the only hue-coded
    series on the page, and the legend carries the mapping. */
const SEGMENT_COLORS = [
  "var(--color-emerald-400, oklch(0.765 0.177 163.223))",
  "var(--color-blue-400, oklch(0.707 0.165 254.624))",
  "var(--color-violet-400, oklch(0.702 0.183 293.541))",
  "var(--color-amber-400, oklch(0.828 0.189 84.429))",
  "var(--color-rose-400, oklch(0.712 0.194 13.428))",
  "var(--color-teal-400, oklch(0.777 0.152 181.912))",
];

export function UsageChart(): React.ReactElement {
  const [metric, setMetric] = useState("requests");
  const [span, setSpan] = useState("24h");
  const { data, error, loading } = useApiList<SeriesData>(
        `/v1/console/observability/series?metric=${metric}&window=${span}`,
  );

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">usage over time</p>
          <p className="text-xs text-muted-foreground">
            {metric === "costUsd" ? "metered spend, stacked per tenant" : "stacked per tenant · utc"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {METRICS.map((m) => (
            <Toggle key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>{m.label}</Toggle>
          ))}
          <span className="mx-1 text-border">|</span>
          {WINDOWS.map((w) => (
            <Toggle key={w.key} active={span === w.key} onClick={() => setSpan(w.key)}>{w.label}</Toggle>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : loading ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full"><BarSkeleton /></svg>
      ) : data ? (
        <SeriesSvg data={data} />
      ) : null}
    </Card>
  );
}

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

const W = 720;
const H = 200;
const PAD = { top: 8, right: 8, bottom: 20, left: 46 };

function SeriesSvg({ data }: { data: SeriesData }): React.ReactElement {
  const totals = data.buckets.map((_, i) => data.series.reduce((s, t) => s + (t.values[i] ?? 0), 0));
  const max = Math.max(...totals, 0);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = data.buckets.length > 0 ? plotW / data.buckets.length : plotW;
  const barW = Math.min(28, band * 0.68);
  const y = (v: number) => PAD.top + plotH * (1 - v / (max || 1));
  const fmt = metricFormat(data.metric);
  // thin the x labels out so dense buckets still leave room to breathe
  const every = Math.max(1, Math.ceil(data.buckets.length / 12));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="usage over time">
        {[0, 0.5, 1].map((f) => {
          const v = max * f;
          const yy = y(v);
          return (
            <g key={f}>
              <line x1={PAD.left} x2={W - PAD.right} y1={yy} y2={yy} stroke="currentColor" className="text-border" strokeWidth="1" strokeDasharray={f === 0 ? undefined : "3 4"} />
              <text x={PAD.left - 6} y={yy + 3.5} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                {fmt(v)}
              </text>
            </g>
          );
        })}

        {data.buckets.map((b, i) => {
          let acc = 0;
          const x = PAD.left + i * band + (band - barW) / 2;
          // label the first bar + a stride, so the axis annotates the window
          const showLabel = i % every === 0 || i === data.buckets.length - 1;
          return (
            <g key={b}>
              {data.series.map((t, si) => {
                const v = t.values[i] ?? 0;
                if (v === 0) return null;
                const y1 = y(acc + v);
                const h = PAD.top + plotH - y1 - (acc === 0 ? 0 : 1);
                const rect = (
                  <rect
                    key={t.tenant}
                    x={x}
                    y={y1}
                    width={barW}
                    height={Math.max(v > 0 ? 1.5 : 0, h)}
                    fill={SEGMENT_COLORS[si % SEGMENT_COLORS.length]}
                    rx={acc + v >= max && acc === 0 ? 2 : 0}
                  >
                    <title>{`${bucketTitle(b, data.window)} · ${t.tenant} · ${fmt(v)}`}</title>
                  </rect>
                );
                acc += v;
                return rect;
              })}
              {showLabel && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                  {bucketTitle(b, data.window)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {data.series.map((t, si) => (
          <span key={t.tenant} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2.5 rounded-sm" style={{ background: SEGMENT_COLORS[si % SEGMENT_COLORS.length] }} />
            {t.tenant}
          </span>
        ))}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          total {fmt(data.total)} over the window
        </span>
      </div>
    </div>
  );
}

/** Flat ground while a bucket row loads — same frame, no misleading values. */
function BarSkeleton(): React.ReactElement {
  return (
    <g className="text-border">
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + 2} y2={PAD.top + 2} stroke="currentColor" strokeWidth="1" />
      <line x1={PAD.left} x2={W - PAD.right} y1={H - 20} y2={H - 20} stroke="currentColor" strokeWidth="1" />
    </g>
  );
}

function metricFormat(metric: string): (v: number) => string {
  if (metric === "costUsd") {
    return (v) => usd(v);
  }
  return (v) => (v >= 10_000 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
}

/** Bucket keys sort as text; the display drops the year to keep the axis tight. */
function bucketTitle(bucket: string, span: string): string {
  if (span === "24h") return bucket.slice(11, 13) + "h";
  return bucket.slice(5, 10);
}