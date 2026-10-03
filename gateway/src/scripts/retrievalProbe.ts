import { bootstrapDatabase } from "../db/index.js";
import { loadKb, retrieve, detectIntent } from "../rag/kb.js";

bootstrapDatabase();
loadKb();
const cases: [string, string][] = [
  ["on-kb", "how do I cancel my order?"],
  ["on-kb", "I want to track my package"],
  ["on-kb", "can I get a refund for my invoice"],
  ["on-kb", "what payment methods do you accept"],
  ["off-kb", "what is the meaning of life"],
  ["off-kb", "how to build a spaceship out of chairs"],
  ["off-kb", "weather forecast for tomorrow"],
  ["off-kb", "tell me a joke about cats"],
];
for (const [tag, q] of cases) {
  const r = retrieve(q);
  const intent = detectIntent(r.entries);
  const raw = r.entries.map((e) => e.score.toFixed(1)).join(", ");
  const sum = r.entries.reduce((s, e) => s + e.score, 0);
  const dominant = sum > 0 ? r.entries[0]!.score / sum : 0;
  console.log(
    tag.padEnd(7),
    `conf=${r.confidence.toFixed(3)}`,
    `dominant=${dominant.toFixed(2)}`,
    `intent=${(intent.intent ?? "—").padEnd(24)}`,
    `intConf=${intent.confidence.toFixed(2)}`,
    `scores=[${raw}]`,
  );
}