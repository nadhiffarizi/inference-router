import { readFileSync } from "node:fs";
import path from "node:path";
import MiniSearch, { type SearchResult } from "minisearch";
import { db } from "../db/index.js";
import { kbEntries } from "../db/schema.js";
import { config } from "../config.js";

/**
 * The support KB: a slice of the Bitext customer-support dataset
 * (bitext/Bitext-customer-support-llm-chatbot-training-dataset — ~27k pairs,
 * 27 intents, templated `{{Order Number}}` placeholders). Loaded from
 * `data/kb.json` (written by `npm run build:kb`) into SQLite, indexed
 * in-process with MiniSearch — lexical retrieval by design (DECISIONS.md D7).
 */

export type KbEntry = { id: number; question: string; answer: string; intent: string; category: string };

let index: MiniSearch<KbEntry> | null = null;
let entriesById: Map<number, KbEntry> = new Map();

export function loadKb(): { entries: number; intents: number } {
  const rows = db.select().from(kbEntries).all();
  entriesById = new Map(rows.map((r) => [r.id, r]));
  index = new MiniSearch<KbEntry>({
    idField: "id",
    fields: ["question", "answer", "intent"],
    storeFields: ["question", "answer", "intent", "category"],
    // Support questions are noisy/abbreviated ("oorder", "acount") — fuzzy
    // matching keeps retrieval useful without an embedding model.
    searchOptions: {
      prefix: true,
      // 0.3: eval questions carry real-world typos ("cancle", "mistkae") —
      // 0.2 misses them; 0.3 catches 2-of-8-char edits in probe testing.
      fuzzy: 0.3,
      boost: { question: 2, intent: 3, answer: 1 },
      combineWith: "OR",
    },
  });
  index.addAll(rows);
  const intents = new Set(rows.map((r) => r.intent)).size;
  return { entries: rows.length, intents };
}

export function isKbLoaded(): boolean {
  return index !== null;
}

export type RetrievedEntry = KbEntry & { score: number };

/**
 * Top-k retrieval + confidence calibration. Calibrated empirically against
 * on-KB vs off-KB questions (see scripts/retrievalProbe.ts):
 *
 *   raw top-hit strength alone overlaps: on-KB 0.63–0.85, off-KB 0.41–0.61
 *   (generic questions like "what is the meaning of life" still match
 *   "what do you accept..." lexically).
 *
 * So the final confidence blends a second, independent signal — intent
 * concentration: legit support questions retrieve entries that AGREE on one
 * intent; generic mush scatters across intents. Blended = strength ×
 * (0.5 + 0.5 × intentConcentration) separates the classes:
 *   on-KB ≈ 0.52–0.91, off-KB ≈ 0.12–0.38 → refusal floor 0.48 (RETRIEVAL_REFUSE_BELOW).
 *
 * This confidence is the same number that drives routing (DECISIONS.md D5):
 * one signal, two decisions (which tier serves, whether to refuse).
 */
export function retrieve(question: string): { entries: RetrievedEntry[]; confidence: number } {
  if (!index) throw new Error("KB not loaded — run npm run build:kb first");
  const hits: SearchResult[] = index.search(question).slice(0, config.assistant.topK);
  const entries: RetrievedEntry[] = hits.map((h) => ({
    id: h.id as number,
    question: String(h.question),
    answer: String(h.answer),
    intent: String(h.intent),
    category: String(h.category),
    score: h.score,
  }));
  if (entries.length === 0 || !entries[0]) return { entries, confidence: 0 };

  const best = entries[0].score;
  // K=120 calibrated on probe data (scripts/retrievalProbe.ts): best-hit raw
  // scores don't overlap the classes — on-KB ≥ 194, off-KB ≤ 134 — the
  // asymptote maps that to conf: on-KB ≥ ~0.62, off-KB ≤ ~0.53.
  const topHitStrength = 1 - 1 / (1 + best / 120);

  // Blend with intent concentration (see doc above): pushes genuine matches
  // up and generic-lexical mush down.
  const intentResult = detectIntent(entries);
  const confidence = topHitStrength * (0.5 + 0.5 * intentResult.confidence);
  return { entries, confidence: Math.min(1, Math.max(0, confidence)) };
}

/** Majority intent of the top hits (weighted by score) — the "detected intent". */
export function detectIntent(entries: RetrievedEntry[]): { intent: string | null; confidence: number } {
  if (entries.length === 0) return { intent: null, confidence: 0 };
  const scores = new Map<string, number>();
  for (const e of entries) scores.set(e.intent, (scores.get(e.intent) ?? 0) + e.score);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [intent, score] = ranked[0]!;
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  return { intent, confidence: total > 0 ? score / total : 0 };
}

export function kbDir(): string {
  return path.resolve("data");
}

export function kbSeedFile(): string {
  return path.join(kbDir(), "kb.json");
}

export function readKbSeed(): KbRow[] {
  return JSON.parse(readFileSync(kbSeedFile(), "utf8")) as KbRow[];
}

export type KbRow = { question: string; answer: string; intent: string; category: string };