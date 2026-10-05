import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { linkProps } from "../router";
import { cn } from "../lib/utils";

/**
 * Shared plumbing for the observability "see all" pages: the top-K tables on
 * /observability stay small, these pages read the same server endpoints with
 * paging, search and filters. One hook + one pager, four pages.
 */

/** Paged response — every see-all endpoint returns this exact shape. */
export type Paged<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  facets: Record<string, string[]>;
};

export type SeriesData = {
  domain: string;
  metric: string;
  bucketKind: "time" | "category";
  buckets: string[];
  /** Latency metrics can emit null for a bucket with no qualifying rows
      (counted metrics never do — the API zero-fills those). */
  series: { tenant: string; values: (number | null)[] }[];
  total: number;
};


/** GET of a paginated list; refetches whenever the caller changes the URL. */
export function useApiList<T>(url: string): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctl = new AbortController();
    let alive = true;
    setLoading(true);
    fetch(url, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as T;
      })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setLoading(false);
      })
      .catch((err: Error) => {
        // an aborted in-flight page load is not an error — the newer one answers
        if (!alive || err.name === "AbortError") return;
        setData(null);
        setError(err.message);
        setLoading(false);
      });
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [url]);

  return { data, error, loading };
}

/** Typing in the search box shouldn't fire a request per keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function LogShell({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mx-auto max-w-6xl space-y-4 pt-5">
      <div>
        <a {...linkProps("/observability")} className="text-xs text-muted-foreground hover:text-foreground">
          ← observability
        </a>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{sub}</p>
      </div>
      {children}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }): React.ReactElement {
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
      <Input
        className="pl-8"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  );
}

export function FilterSelect({
  value, onChange, options, allLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allLabel: string;
}): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

/** Day range (native calendar pickers), inclusive both ends — drives the
    table and the charts above it, which re-bucket to the picked span
    (hourly ≤ 2 days, otherwise daily). Values are YYYY-MM-DD; "" = unbounded. */
export function DateRangeFilter({
  from, to, onChange, label = "dates",
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  label?: string;
}): React.ReactElement {
  const active = from !== "" || to !== "";
  return (
    <label className={cn("flex h-9 items-center gap-1 rounded-md border bg-background px-1.5 shadow-xs", active ? "border-input" : "border-input text-muted-foreground")}>
      <span className="px-0.5 text-xs">{active ? "range" : label}</span>
      <input
        type="date"
        aria-label={`${label} from`}
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        className="w-28 bg-transparent font-mono text-xs text-foreground outline-none"
      />
      <span className="text-xs text-muted-foreground">–</span>
      <input
        type="date"
        aria-label={`${label} to`}
        value={to}
        min={from || undefined}
        onChange={(e) => onChange(from, e.target.value)}
        className="w-28 bg-transparent font-mono text-xs text-foreground outline-none"
      />
      {active && (
        <button
          type="button"
          aria-label="clear date range"
          onClick={() => onChange("", "")}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );
}

export function Pager({
  total, limit, offset, onPage,
}: {
  total: number;
  limit: number;
  offset: number;
  onPage: (offset: number) => void;
}): React.ReactElement {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + limit);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t py-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {total === 0 ? "no rows" : `${from}–${to} of ${total} rows`}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
          <ChevronLeft className="size-3.5" /> prev
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">page {Math.min(page, pages)} / {pages}</span>
        <Button variant="outline" size="sm" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)}>
          next <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Section header on /observability: the K-limited table plus its "see all" link. */
export function SectionHeader({ title, seeAllHref, seeAllLabel }: { title: string; seeAllHref?: string; seeAllLabel?: string }): React.ReactElement {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3")}>
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      {seeAllHref && (
        <a
          {...linkProps(seeAllHref)}
          className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {seeAllLabel ?? "see all"} →
        </a>
      )}
    </div>
  );
}