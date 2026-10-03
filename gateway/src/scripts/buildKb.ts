import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";

/**
 * Ingest: pull a slice of the Bitext customer-support dataset from
 * HuggingFace's datasets-server (no auth needed), write the KB slice and the
 * held-out eval slice.
 *
 * Strategy (brief: "a slice as the knowledge base and a held-out slice for
 * evaluation"): fetch a few thousand rows, then take a deterministic,
 * intent-stratified sample:
 *   - kb:   ~4 rows per intent        (→ data/kb.json)
 *   - eval: exactly 30 rows           (→ data/eval.json)  — disjoint from kb
 * Held-out rows are ones the KB has never seen, so retrieval is genuinely
 * tested rather than parroting.
 */

const DATASET = "bitext/Bitext-customer-support-llm-chatbot-training-dataset";
/**
 * The dataset ships as one CSV in the HF repo (~91k lines, 27 intents).
 * Downloading it once beats polling datasets-server /rows (rate-limited hard
 * for anonymous use, and the table is intent-ordered so head-only sampling
 * misses 24 intents). Cached to data/raw.csv after the first run.
 */
const CSV_URL = `https://huggingface.co/datasets/${DATASET}/resolve/main/Bitext_Sample_Customer_Support_Training_Dataset_27K_responses-v11.csv`;
const KB_PER_INTENT = 4;
const EVAL_SIZE = 30;

type Row = { instruction: string; response: string; intent: string; category: string };

const HEADERS = { "User-Agent": "mini-inference-router-kb-ingest" };

/** Download (once) then parse the CSV. RFC-4180 subset: quotes, doubled quotes, CRLF. */
async function downloadCsv(dest: string): Promise<void> {
  const res = await fetch(CSV_URL, { headers: HEADERS });
  if (!res.ok || !res.body) throw new Error(`CSV download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  if (field || row.length) { row.push(field); if (row.some((f) => f.length > 0)) rows.push(row); }
  return rows;
}

async function fetchRows(): Promise<Row[]> {
  const raw = path.resolve("data/raw.csv");
  if (!existsSync(raw)) {
    console.log(`Downloading ${CSV_URL} …`);
    await downloadCsv(raw);
  }
  const text = readFileSync(raw, "utf8");
  const table = parseCsv(text);
  const header = table[0] ?? [];
  const cols = { flags: header.indexOf("flags"), instruction: header.indexOf("instruction"), category: header.indexOf("category"), intent: header.indexOf("intent"), response: header.indexOf("response") };
  if (cols.instruction < 0 || cols.response < 0 || cols.intent < 0) throw new Error(`unexpected CSV header: ${header.join(",")}`);
  return table.slice(1).map((r) => ({
    instruction: r[cols.instruction] ?? "",
    response: r[cols.response] ?? "",
    intent: r[cols.intent]?.trim() ?? "",
    category: r[cols.category]?.trim() ?? "",
  }));
}

/** Deterministic PRNG so the KB/eval split is reproducible across machines. */
function makeRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function stratifiedSplit(rows: Row[]): { kb: Row[]; eval: Row[] } {
  const rand = makeRandom(42);
  const byIntent = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byIntent.has(r.intent)) byIntent.set(r.intent, []);
    byIntent.get(r.intent)!.push(r);
  }
  // Interleave intents so KB/eval picks aren't the first-N bias.
  const kb: Row[] = [];
  const evalSet: Row[] = [];
  for (const [, list] of byIntent) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
  }
  for (const [intent, list] of byIntent) {
    void intent;
    kb.push(...list.slice(0, KB_PER_INTENT));
  }
  // Eval: round-robin across intents until 30, always beyond the KB slice
  // (idx >= KB_PER_INTENT), so eval rows were never put in the KB.
  const intentNames = [...byIntent.keys()].sort();
  let picked = 0;
  for (let round = 0; picked < EVAL_SIZE && round < 50; round++) {
    for (const intent of intentNames) {
      if (picked >= EVAL_SIZE) break;
      const list = byIntent.get(intent)!;
      const row = list[round + KB_PER_INTENT];
      if (row) {
        evalSet.push(row);
        picked++;
      }
    }
  }
  return { kb, eval: evalSet };
}

async function main(): Promise<void> {
  console.log(`Loading ${DATASET} …`);
  const rows = await fetchRows();
  console.log(`Loaded ${rows.length} rows`);

  const { kb, eval: evalSet } = stratifiedSplit(rows);
  const outDir = path.resolve("data");
  mkdirSync(outDir, { recursive: true });

  const kbOut = kb.map((r) => ({ question: r.instruction, answer: r.response, intent: r.intent, category: r.category }));
  const evalOut = evalSet.map((r) => ({ question: r.instruction, answer: r.response, intent: r.intent, category: r.category }));

  writeFileSync(path.join(outDir, "kb.json"), JSON.stringify(kbOut, null, 2));
  writeFileSync(path.join(outDir, "eval.json"), JSON.stringify(evalOut, null, 2));

  const kbIntents = new Set(kbOut.map((r: { intent: string }) => r.intent));
  const evalIntents = new Set(evalOut.map((r: { intent: string }) => r.intent));
  console.log(`KB rows: ${kbOut.length} (${kbIntents.size} intents) → data/kb.json`);
  console.log(`Eval rows: ${evalOut.length} (${evalIntents.size} intents) → data/eval.json`);
  console.log("Row-level disjoint by construction (eval idx >= KB_PER_INTENT per intent)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});