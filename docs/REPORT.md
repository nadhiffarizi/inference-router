# Technical Report — Mini Inference Router

Brief for the assessors: the decision log ([`DECISIONS.md`](DECISIONS.md)) was
written **before** any code; this report records what was measured afterwards,
where the numbers changed my mind, and where scope grew deliberately while
building — each growth stated with its reason (D11–D15).

## 1. What was built

One system, three pieces:

1. **Gateway** (Fastify/TypeScript) — the assessed product. Bearer-key auth →
   fail-closed quota → rule-based routing → backend adapters → metering →
   SQLite. Streaming everywhere (SSE), full turn traces stored.
2. **Support assistant** — a *capability inside* the gateway, not a second
   service: retrieval → confidence → (refuse | route) → grounded answer +
   intent, on the same auth/quota/metering path as plain chat. Optional
   caller-declared `sessionId` groups turns into sessions (grouping only —
   never model context).
3. **Console** (React/Vite, shadcn-style design system) — accounts (session
   login, no JWT), role-scoped sidebar: product team sees `Playground ·
   API Keys · Usage`; admin is a tenant like any other plus one extra menu,
   `Observability`: fleet usage, per-key breakdown, the activity feed
   (openrouter-style: one row per gateway call), and trace/session viewers
   (Langfuse-style: question, answer, retrieval, routing plan, metering per
   turn), all from stored turn traces.

## 2. Routing: the rules and why

Two real backends through OpenRouter + a scripted mock:

| backend | model | measured avg latency | measured cost/30 cases |
|---|---|---|---|
| tier A | `google/gemini-2.5-flash-lite` | ~506 ms | $0.00383 |
| tier B | `anthropic/claude-haiku-4.5` | ~1569 ms | $0.04449 |
| mock | scripted latency/failure | configured | $0 |

Rules (first match wins; inputs are signals the request already produced) —

1. **Refuse gate (assistant):** retrieval confidence < 0.48 → no model call.
2. **Tier A** for simple-shape questions with strong retrieval.
3. **Tier B** for weak retrieval (ambiguity → worth stronger reasoning) or
   complex questions (long / multi-clause / comparison wording).
4. **Fallback:** on upstream error or stall → next candidate. Fallback applies
   until the first byte; after that a mid-stream fault is surfaced as an
   explicit `error` event rather than re-routed, because re-routing
   mid-answer would splice or duplicate content.

Every choice is written to `routing_decisions` (candidates, action, reason)
and rendered in the console — "recorded and inspectable" is a table, not a
log file. The full rationale, thresholds, and worked examples:
[`RULES.md`](RULES.md).

**Why these rules are defensible, not arbitrary:** each one maps to a measured
trade-off from §4. Tier B costs 11.6× more for the same intent accuracy — so
"capable tier for *ambiguous or complex* requests only" is a cost/quality
position, not a preference. The stall→fallback threshold exists because a
production proxy kills long requests anyway (learned operating an
OpenRouter-backed app: stalled upstreams turned into 524s); a gateway should
fail *over* before the proxy fails *down*.

## 3. Retrieval and the confidence signal

Lexical (MiniSearch, fuzzy 0.3, question/intent boosted) over a 324-row
intent-stratified slice of Bitext; 30 further rows held out for eval. No
embeddings: OpenRouter exposes no embedding endpoint and this is the honest
budget line for one day (see D7). Iterated with measurement, not vibes:

| iteration | change | intent accuracy |
|---|---|---|
| v1 | 4 rows/intent, fuzzy 0.2 | 63% |
| v2 | 8 rows/intent | 60%* |
| v3 | 12 rows/intent + fuzzy 0.3 + floor recalibrated 0.42→0.48 | **87%** |

*new held-out slice — not directly comparable, kept for the record.

**Confidence is calibrated from data, not tuned to look nice** — on-KB
questions and off-KB questions were scored separately (see
`gateway/src/scripts/retrievalProbe.ts`): v3 separates on-KB (0.56–0.81) from
off-KB (0.12–0.44), and the refusal floor sits at 0.48 between them. One
confidence number drives two decisions (tier choice and refuse-vs-answer),
documented in `rag/kb.ts`.

The refusal path is a designed outcome, not an error: `refused: true` with the
reason, metered as a served-but-zero-cost request. Unusable model output
(empty/trivially short) is refused the same way.

## 4. Evaluation

30 held-out cases through the **real request path** (the eval pins a backend
via `backendPin` and still pays auth, quota, metering). Answer quality graded
by LLM-as-judge (same-key direct call, 1–5 groundedness against retrieved
context) — judge comments per case land in `eval/results/`.

| metric | A (tier A) | B (tier B) | better |
|---|---|---|---|
| intent accuracy | 87% | 87% | tie |
| refusal rate on held-out cases | 0% | 0% | — |
| error rate | 0% | 0% | — |
| avg / p95 latency | 506 / 757 ms | 1569 / 2132 ms | A |
| total cost (30 cases) | $0.00383 | $0.04449 | A |
| avg groundedness | 3.37 | 4.10 | **B** |

Read: **tier B buys measurable answer quality (+0.73 groundedness) at 11.6×
cost and 3× latency**. Accuracy is carried by retrieval, not the model — both
tiers misclassify the same hard cases (typos + paraphrase). That's the case
for routing the bulk to A and reserving B for weak-retrieval/complex requests;
it also says where the next real win is (retrieval quality, not a bigger
model). Full table and per-case detail: [`EVALUATION.md`](EVALUATION.md).

Measured routing behaviour (also shown live in the decision log):

- complex chat question → tier B (`chat: complex question`)
- simple assistant question, conf 0.54 → tier A
- `ROUTING_CHAIN=mock,openrouter-tier-a` + scripted failure → `mock → failed`,
  `openrouter-tier-a → served`, `fallbackTriggered: true`
- hung backend → per-chunk router timeout aborts it into fallback (a real bug
  found by a probe before it became a demo incident: a generator awaiting
  `sleep` ignores the fetch `AbortController`)
- quota exhausted → `429` with limits/remaining/reset in the body

## 5. Exceptions and failure handling

- All errors are machine-readable: `{error: {code, message, details}}` with
  correct status (401/400/403/409/429/503/502/500). Quota checks that *cannot
  verify* (DB down) deny rather than assume — failing closed twice over.
- Metering never blocks the request path; failed metering is logged loudly
  instead of crashing a served request.
- Session/tenancy violations are server-enforced (`403`), not hidden in UI.
- The judge in eval degrades honestly: without a key it prints its absence
  rather than fabricating numbers.

## 6. Scope: what was cut, and what deliberately grew

Cut deliberately rather than half-build (**still cut**):

- Conversation history / multi-turn model memory (sessions group traces; the
  model stays single-turn — see D15 for the boundary).
- Full RBAC — no users × permissions matrix; identity is one role bit on a
  tenant-scoped account (D11).
- Sliding-window quotas (fixed daily window), retries beyond one fallback hop,
  WebSocket, vector retrieval / reranking, cost-calibration wizard.

Grew **on purpose** while building, each for a stated reason (full args in the
addendum D11–D15): console accounts + one-irreplaceable-key issuance flow
(makes tenancy and "enforces what each tenant is allowed" *demonstrable*
instead of asserted), USD spend budgets, named keys with per-key usage,
activity feed + trace viewer, chat sessions with soft delete. Nothing on the
assessed path regressed: auth, quota, routing, metering, eval all behave as
measured before the console grew.

## 7. Known limitations (said plainly)

- 87% intent accuracy is carried by lexical retrieval; a stronger classifier
  (embeddings or an intent-specific model) is the obvious next step.
- The LLM judge shares the provider ecosystem with the gateway — mild
  self-grading bias; scores are treated as relative, not absolute.
- Demo credentials are shared and documented (assessment context); keys are
  irreplaceable by design — lost plaintexts reset with demo fixtures.
- SQLite is fine for demo scale only; see D6 for the Postgres swap path.
- Single instance; no horizontal scaling story is claimed. Sessions are
  gateway-level grouping only — cross-conversation memory would be the
  product layer's job.