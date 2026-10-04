# Routing rules — how the gateway picks a backend

Purpose: the single document to read (or defend the system from) when asked
"who decides which model serves a request, and is that arbitrary?". It mirrors
the code in `gateway/src/routing/rules.ts` (policy), `dispatch.ts` (fallback
mechanics), and the thresholds in `config.ts`.

## TL;DR

The router never calls a model to pick a model. It evaluates three cheap
signals that already exist by the time a request is in flight, produces an
**ordered candidate plan** (primary + fallbacks with a written reason each),
and then walks the plan until a backend streams its first byte. Every step of
every decision is written to `routing_decisions` and rendered in the console.

## The signals (all local, all cheap)

| signal | how it's computed | cost |
|---|---|---|
| **question complexity** | `questionComplexity()` — long (>240 chars), multi-clause (≥2 of: "because/however/compare/explain/policy/…"), or multi-question (>1 `?`) → `complex`, else `simple` | microseconds |
| **retrieval confidence** (assistant only) | normalized top-hit strength × intent concentration over MiniSearch matches, see below | in-process lexical search |
| **capability** | which endpoint was called: `chat` or `support-assistant` | free |

Retrieval confidence calibration (why these numbers): probe data in
`gateway/src/scripts/retrievalProbe.ts` — on-KB questions land 0.56–0.81,
off-KB 0.12–0.44. The refusal floor 0.48 sits between the classes with margin
on both sides. It's a measured threshold, not a vibe.

Two confidence thresholds, deliberately **not** the same number:

- `RETRIEVAL_REFUSE_BELOW` (0.48) — below this the assistant refuses instead
  of guessing. Nothing at all is routed.
- `RETRIEVAL_TIER_B_BELOW` (0.55, clamped ≥ the floor) — below this, but above
  the floor, confidence is "weak": the question is still answered, and the
  capable tier takes it, because an ambiguous match justifies stronger
  reasoning.

The swap threshold being strictly above the floor is what makes the
weak-retrieval → tier-B rule live: a band `[0.48, 0.55)`. If the two were the
same number, the band collapses to empty and the tier swap becomes dead code
(the refusal gate runs first and would consume every weak result).

## The decision (first match wins)

```
1. assistant capability AND confidence < 0.48
      → REFUSE: no model is called at all (metered as refused, zero cost)
      reason: "retrieval confidence 0.31 < floor 0.48"

2. otherwise compute primary tier:
      chat:           simple question → tier A (fast/cheap)
                      complex question → tier B (capable)
      assistant:      weak retrieval (0.48 ≤ conf < 0.55 — answered, but
                      ambiguous → stronger tier) OR complex question → tier B
                      strong retrieval + simple → tier A

3. build the plan: [primary, the other tier]  ← cross-tier fallback is baked in

4. (env override) ROUTING_CHAIN reorders/limits candidates for demos, e.g.
   "mock,openrouter-tier-a" so fallback fires deterministically on video.
```

Worked examples (real values from the live system):

| request | signals | plan & reason |
|---|---|---|
| "how do I cancel my order?" | assistant, conf **0.80**, simple | tier A first — "retrieval confidence 0.80 (strong), simple question" |
| "Explain why gateways need fallback, compare two failure modes in detail…" | chat, 386 chars | tier B first — "chat: complex question" |
| "is the moon made of cheese?" | assistant, conf **0.37** | **no call** — refuse ("0.37 < floor 0.48") |
| same question with `ROUTING_CHAIN=mock,tier-a`, mock told to hang | — | mock → stalled 1.5s → tier A served, `fallbackTriggered: true` |

## Fallback mechanics (`dispatch.ts`)

- **Retry boundary = first byte.** Each candidate is given a chance to
  *produce output*; on upstream error, empty stream, or stall, it's marked
  `failed` with the actual error in the plan and the next candidate runs.
- **Per-chunk router guard:** the router races every chunk against the
  adapter's timeout (tier A 8s, tier B 20s, mock 6s, env-tunable). This is
  belt-and-braces over the adapter's own `AbortController` — a regression
  probe proved a generator awaiting an internal `sleep` ignores the fetch
  abort, and the route previously hung forever. Now it cannot.
- **No mid-stream re-routing.** Once a backend has started streaming to the
  client, a fault is surfaced as an explicit `error` SSE event. Re-routing
  mid-answer would splice or duplicate content — *correct-looking, wrong* is
  worse than visibly failed.
- Chain exhaustion → `502 backend_unavailable` with the full plan attached.

## Hardcoded vs configurable — and why that split

**In code (policy, on purpose):** the rule ORDER, what a "capability" is, the
complexity heuristics and hint words, the retry-until-first-byte boundary.
These are the parts I want reviewers to read and argue with — they're the
"rules you can defend".

**In env (`config.ts` / `.env`):** which models are tier A/B (`TIER_A_MODEL`
etc.), their timeouts and price constants, the refusal floor
(`RETRIEVAL_REFUSE_BELOW`), the tier-B swap threshold
(`RETRIEVAL_TIER_B_BELOW`), top-k (`RETRIEVAL_TOP_K`), quota caps, and
`ROUTING_CHAIN` (demo override only). Operations shouldn't edit code to move
a threshold; reviewers can see the value in `.env.example`.

## Why no LLM-in-the-router

A router that runs a model call to choose the model pays the exact latency and
cost the gateway exists to remove — and it's unfalsifiable at 2am. The
signals here are deterministic and logged: every row in `routing_decisions`
shows which signal fired, so a wrong route is *debuggable*, not arguable.

## What production would add (declared, not hidden)

- live health signals: EWMA latency per backend, error-rate circuit breakers
- cost-aware SLA routing (p95 budget → tier pinning)
- hedged requests (fire tier B after tier A's p90, keep first answer)
- per-tenant route policies (this demo's tenancy gates capabilities; a real
  product would let each tenant declare its own SLA/quality preference)