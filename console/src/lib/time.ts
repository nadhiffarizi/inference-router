/**
 * Time display, in one place. The gateway writes ISO-8601 UTC into SQLite and
 * buckets its series on the same UTC prefixes, so every conversion from UTC to
 * what the reader actually sees happens here, at render time — the stored
 * strings never leave the API as anything but UTC.
 */

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const SHORT_DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const CLOCK_FMT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** The viewer's IANA zone, for the chart subtitles ("browser time" is ambiguous if you don't name it). */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

/** HH:MM:SS in the viewer's timezone — the time half of localStamp; not used
    standalone for rows, which carry the date too (every trace/listing shows
    the full date+time, never a bare clock). */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : TIME_FMT.format(d);
}

/** YYYY-MM-DD HH:MM:SS in the viewer's timezone — trace/sheet titles. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${localTime(iso)}`;
}

/** YYYY-MM-DD in the viewer's timezone. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a series bucket — the server groups on UTC ISO prefixes, so the raw
    prefix has no zone. Only exact prefixes the endpoint actually emits are
    expected here; anything else renders as the raw string. */
function bucketInstant(bucket: string): Date | null {
  const iso = bucket.length === 13 ? `${bucket}:00:00Z` : bucket.length === 10 ? `${bucket}T00:00:00Z` : null;
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Axis tick: an hour bucket reads as the viewer's clock ("15:00"), a day
    bucket as its date ("Oct 4"). */
export function bucketAxisLabel(bucket: string, kind: "time" | "category"): string {
  if (kind === "category") return bucket.slice(0, 14);
  const d = bucketInstant(bucket);
  if (!d) return bucket;
  return bucket.length === 13 ? CLOCK_FMT.format(d) : DAY_FMT.format(d);
}

/** Tooltip: the bucket's start instant, full date + time (the chart subtitle names the zone). */
export function bucketTooltipLabel(bucket: string, kind: "time" | "category"): string {
  if (kind === "category") return bucket;
  const d = bucketInstant(bucket);
  return d ? SHORT_DATE_TIME_FMT.format(d) : bucket;
}