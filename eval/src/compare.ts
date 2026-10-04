import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunSummary } from "./data.js";

/**
 * Renders the A/B comparison table (brief: "Run it against two configurations
 * … and compare") into docs/EVALUATION.md. Numbers only here — interpretation
 * and trade-offs belong to docs/REPORT.md, which the table feeds.
 */

function load(cfg: string): RunSummary {
  return JSON.parse(
    readFileSync(path.resolve("results", `config-${cfg}.json`), "utf8"),
  ) as RunSummary;
}

const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`;
const fmt = (n: number, digits = 0) => n.toFixed(digits);

function row(label: string, a: string, b: string, betterOn: "A" | "B" | "—" = "—"): string {
  return `| ${label} | ${a} | ${b} | ${betterOn} |`;
}

/** Better on this metric: higher-is-better → cmp "gt", lower-is-better → "lt". Ties are ties. */
function betterOn(a: number, b: number, cmp: "gt" | "lt"): "A" | "B" | "—" {
  if (a === b) return "—";
  const aWins = cmp === "gt" ? a > b : a < b;
  return aWins ? "A" : "B";
}

export function buildTable(a: RunSummary, b: RunSummary): string {
  const lines = [
    "## A/B comparison — 30 held-out Bitext cases through the gateway",
    "",
    `Config A = ${a.backendPin} pinned · Config B = ${b.backendPin} pinned · run at ${a.startedAt.slice(0, 16)}Z`,
    "",
    "| metric | A | B | better |",
    "|---|---|---|---|",
    row("intent accuracy", fmtPct(a.metrics.intentAccuracy), fmtPct(b.metrics.intentAccuracy), betterOn(a.metrics.intentAccuracy, b.metrics.intentAccuracy, "gt")),
    row("refusal rate", fmtPct(a.metrics.refusalRate), fmtPct(b.metrics.refusalRate)),
    row("error rate", fmtPct(a.metrics.errorRate), fmtPct(b.metrics.errorRate), betterOn(a.metrics.errorRate, b.metrics.errorRate, "lt")),
    row("avg latency (ms)", fmt(a.metrics.avgLatencyMs), fmt(b.metrics.avgLatencyMs), betterOn(a.metrics.avgLatencyMs, b.metrics.avgLatencyMs, "lt")),
    row("p95 latency (ms)", fmt(a.metrics.p95LatencyMs), fmt(b.metrics.p95LatencyMs), betterOn(a.metrics.p95LatencyMs, b.metrics.p95LatencyMs, "lt")),
    row("total cost (USD)", fmt(a.metrics.totalCostUsd, 5), fmt(b.metrics.totalCostUsd, 5), betterOn(a.metrics.totalCostUsd, b.metrics.totalCostUsd, "lt")),
  ];

  const gA = a.metrics.avgGroundedness;
  const gB = b.metrics.avgGroundedness;
  lines.push(
    row(
      "avg groundedness (1–5)",
      gA == null ? "n/a" : fmt(gA, 2),
      gB == null ? "n/a" : fmt(gB, 2),
      gA == null || gB == null ? "—" : betterOn(gA, gB, "gt"),
    ),
  );
  return lines.join("\n") + "\n";
}

function perCaseAppendix(a: RunSummary, b: RunSummary): string {
  const lines = ["", "## Per-case detail", "", "| question | expected intent | A → intent | B → intent |", "|---|---|---|---|"];
  for (let i = 0; i < a.cases.length; i++) {
    const ca = a.cases[i]!;
    const cb = b.cases[i]!;
    lines.push(`| ${ca.question.slice(0, 60)} | ${ca.expectedIntent} | ${ca.error ? "ERR" : ca.refused ? "refused" : ca.detectedIntent ?? "—"} | ${cb.error ? "ERR" : cb.refused ? "refused" : cb.detectedIntent ?? "—"} |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1]?.endsWith("compare.ts")) {
  try {
    const a = load("A");
    const b = load("B");
    const md = buildTable(a, b) + perCaseAppendix(a, b);
    const out = path.resolve("../docs/EVALUATION.md");
    writeFileSync(out, md);
    console.log(md);
    console.log(`\nwrote ${out}`);
  } catch (err) {
    console.error("run both configs first (npm run eval):", String(err));
    process.exit(1);
  }
}