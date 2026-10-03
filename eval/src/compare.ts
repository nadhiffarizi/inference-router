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

export function buildTable(a: RunSummary, b: RunSummary): string {
  const lines = [
    "## A/B comparison — 30 held-out Bitext cases through the gateway",
    "",
    `Config A = ${a.backendPin} pinned · Config B = ${b.backendPin} pinned · run at ${a.startedAt.slice(0, 16)}Z`,
    "",
    "| metric | A | B | better |",
    "|---|---|---|---|",
    row("intent accuracy", fmtPct(a.metrics.intentAccuracy), fmtPct(b.metrics.intentAccuracy), (a.metrics.intentAccuracy >= b.metrics.intentAccuracy ? "A" : "B")),
    row("refusal rate", fmtPct(a.metrics.refusalRate), fmtPct(b.metrics.refusalRate)),
    row("error rate", fmtPct(a.metrics.errorRate), fmtPct(b.metrics.errorRate), (a.metrics.errorRate <= b.metrics.errorRate ? "A" : "B")),
    row("avg latency (ms)", fmt(a.metrics.avgLatencyMs), fmt(b.metrics.avgLatencyMs), (a.metrics.avgLatencyMs <= b.metrics.avgLatencyMs ? "A" : "B")),
    row("p95 latency (ms)", fmt(a.metrics.p95LatencyMs), fmt(b.metrics.p95LatencyMs), (a.metrics.p95LatencyMs <= b.metrics.p95LatencyMs ? "A" : "B")),
    row("total cost (USD)", fmt(a.metrics.totalCostUsd, 5), fmt(b.metrics.totalCostUsd, 5), (a.metrics.totalCostUsd <= b.metrics.totalCostUsd ? "A" : "B")),
    row("avg groundedness (1–5)", a.metrics.avgGroundedness == null ? "n/a" : fmt(a.metrics.avgGroundedness, 2), b.metrics.avgGroundedness == null ? "n/a" : fmt(b.metrics.avgGroundedness, 2), a.metrics.avgGroundedness != null && b.metrics.avgGroundedness != null && a.metrics.avgGroundedness >= b.metrics.avgGroundedness ? "A" : "B"),
  ];
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