import type { CaseResult } from "./data.js";

/**
 * LLM-as-judge for answer quality (DECISIONS.md D8): groundedness 1–5 against
 * the retrieved context, asked to penalize invention. Runs on the same
 * OpenRouter key as the gateway (env OPENROUTER_API_KEY) but *directly* —
 * it's offline analysis of transcripts, not requests through the router.
 *
 * No key configured → judgeAll rejects → run.ts proceeds without groundedness
 * (the report then says so; measurement is honest or absent, never faked).
 */

const MODEL = process.env.JUDGE_MODEL?.trim() || "google/gemini-2.5-flash-lite";

type JudgeVerdict = { score: number; comment: string };

export async function judgeAll(results: CaseResult[]): Promise<Map<string, JudgeVerdict>> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key || key.startsWith("PLACEHOLDER")) {
    throw new Error("no OPENROUTER_API_KEY — skipping judge");
  }
  const scored = new Map<string, JudgeVerdict>();
  const pool = 4;
  const todos = results.filter((r) => !r.error && !r.refused && r.answer.length > 0);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(pool, todos.length) }, async () => {
      while (index < todos.length) {
        const r = todos[index++]!;
        try {
          scored.set(r.question, await judge(key!, r));
        } catch (err) {
          console.warn(`judge failed for "${r.question.slice(0, 40)}": ${String(err).slice(0, 120)}`);
        }
      }
    }),
  );
  return scored;
}

async function judge(key: string, r: CaseResult): Promise<JudgeVerdict> {
  const retrieved = r.retrievedIntents.join(", ") || "none";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "http://localhost", "X-Title": "Mini Inference Router eval" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 220,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You grade a support-chatbot answer for GROUNDEDNESS. Return JSON {\"score\": 1-5, \"comment\": <one sentence>}. " +
            "5 = fully supported by the retrieved entries; 4 = minor invention; 3 = supported but vague; 2 = mostly invented; 1 = contradicts or fully invented.",
        },
        {
          role: "user",
          content:
            `Customer question: ${r.question}\nRetrieved intents: ${retrieved}\n\nAnswer to grade:\n${r.answer}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("judge empty response");
  const parsed = JSON.parse(content) as { score?: number; comment?: string };
  const score = Math.max(1, Math.min(5, Number(parsed.score) || 0));
  return { score, comment: parsed.comment ?? "" };
}