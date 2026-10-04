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
confidence signal drives two decisions at two thresholds: the refusal floor
(`RETRIEVAL_REFUSE_BELOW`, 0.48) asks *answer vs refuse*, and the tier-B swap
(`RETRIEVAL_TIER_B_BELOW`, 0.55) asks *tier A vs tier B* — the band
`[0.48, 0.55)` is "answered, but ambiguous", documented in `RULES.md`.

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

## 8. Demo test plan — the chosen case set, and why the rest isn't demoed

The full behavioural case table (every routing pick and every refuse /
fallback / fail shape, ~25 cases) was reviewed and then **deliberately
narrowed** to what an assessor can drive with a single tool: hit the API with
Postman/curl, watch the response, confirm the decision trail in Observability.
No demo-specific code, no environment menu — the graded behaviour is shown
raw, and everything demonstrated is shipped, on-demand behaviour.

### 8.1 The chosen set

**A. Primary pick** (`routing/rules.ts` — first match wins, default = tier A)

| # | capability | signals | primary | reason string |
|---|-----------|---------|---------|---------------|
| 1 | chat | simple: ≤240 chars, <2 hint words, ≤1 `?` | tier A | `chat: simple question` |
| 2 | chat | complex: >240 chars OR ≥2 hint words (`because/however/difference/compare/explain/why/multiple/steps/detailed/policy/also`) OR >1 `?` | tier B | `chat: complex question` |
| 3 | support-assistant | conf ≥ 0.55 + simple shape | tier A | `assistant: retrieval confidence 0.80 (strong), simple question` |
| 4 | support-assistant | conf in [0.48, 0.55) — weak band, any shape; or complex shape | tier B | `assistant: retrieval confidence 0.50 (weak), simple question` |
| 5 | support-assistant | `backendPin` = known backend id (`openrouter-tier-b`/-a/`mock`) | pinned first, remaining real tier(s) as fallback | `pinned by request (eval A/B): ...` |
| 6 | any | `backendPin` = unknown id | — | `400 invalid_input` with the allowed ids |
| 7 | any | `ROUTING_CHAIN="mock,openrouter-tier-a"` | chain order first, leftovers appended | `demo override (ROUTING_CHAIN position i): ...` |

Plan is always `[primary, the other real tier]` — cross-tier fallback baked
in; the mock is never picked by policy (only via 5/7).

**B. Refuse / fallback / fail**

| # | case | trigger | model called? | outcome |
|---|------|---------|---------------|---------|
| 1 | Refuse — low confidence | conf < 0.48 (e.g. *"is the moon made of cheese?"* ≈ 0.37) | none | `refused: true`, cost 0, outcome `refused`, still consumes a request slot (`bumpQuota(id, 0)`) |
| 2 | Refuse — complex + low conf | complexity high **and** conf < 0.48 | none | refused before routing — tier B never reached even for complex questions |
| 3 | Refuse — unusable output | answer < 15 chars after trim (14 → refused; 15 → served; whitespace-only refused) | yes, then discarded | converted to refusal; token/request counters not bumped, USD spend still recorded |
| 4 | Fallback → next tier | candidate error / stall past timeout (A 8s, B 20s, mock 6s) / empty stream, before first byte | yes, then next | failed/abandoned step → next serves, `fallbackTriggered: true`; unreached tail recorded `skipped` |
| 5 | Quota — requests | used+1 > requestsPerDay (the `stress` seed tenant: 3/day) | none | 429 `quota_exceeded` + `{limit, used, reset}` |
| 6 | Auth — unknown/foreign key | wrong key; keys are SHA-256 at rest, one key = one tenant | none | 401 |
| 7 | Validation | empty message, >4000 chars, unknown field | none | 400 `invalid_input` (schema, `additionalProperties: false`) |
| 8 | Upstream outage | both tiers unreachable | tried both | 502 `backend_unavailable` — full plan in body |

### 8.2 Full coverage vs this set — what is NOT demoed, and why

| dropped from the full table | why we don't demo it | where the property is still evidenced |
|---|---|---|
| confidence boundary, conf **exactly** 0.48 | retrieval confidence is a continuous score — no question reliably lands on 0.480; a boundary request would be luck, not a case | the floor's two neighbourhoods ARE demoed: 0.37 refuses (B1), 0.50 routes weak (A4), 0.80 routes strong (A3); comparator cited (`rules.ts`, `assistant.ts` refusal gate) |
| quota — tokens/day and USD budget axes | same `checkQuota` code path with the identical 429 shape (`quota.ts:66-77`); demoing one axis is the whole fail-closed story, and the spend axis moves ~1e-4 USD per request — nearly invisible in a live demo (`budgetUsdPerDay: 0.7`) | eval + observability data carry the axes; `FLOW.md` documents the counters |
| quota boundary semantics (#200 allowed, #201 denied) | implicit in B5 — the check `used + 1 > limit` is quoted rather than staged as a separate scene | `quota.ts` + the 429 body's own `limit`/`used` fields prove the semantics |
| quota concurrency race (two requests passing check-then-bump) | non-deterministic — needs a parallel fire to demonstrate, and its absence/presence is not a graded behaviour; single-instance SQLite check-then-bump is not atomic and is listed as a known limitation instead | §7 limitation + `lib/quota.ts`; the atomic-reserve fix is proposed, deferred |
| quota DB down → `503 quota_uncertain` | needs the in-process SQLite broken mid-run; there is no honest lever for it, and faking the DB failure would misrepresent more than it proves | branch is code-auditable (`lib/quota.ts:80-84`, `plugins/auth.ts`) and the fail-closed posture is shown by B5–B7 instead |
| missing Authorization header (401) | not dropped on merit — omitted as redundant with the unknown-key curl (B6); same fail-closed auth, same `{error:{code,message}}` shape | the unknown-key case B6 demonstrates the identical shape; it is the trivially cheap extra curl if wanted |
| complexity boundary, 240 vs 241 chars | the boundary IS the rule shown by A1 vs A2 — a third request one character longer adds a scene without adding a failure shape; substring/case semantics cited from code (`rules.ts` `questionComplexity`) | A1/A2 pair; boundary constants quoted |
| mid-stream fault (error after first byte) | no on-demand trigger exists: the mock can only fail *before* first byte, and real provider faults aren't scriptable to a scene; would need a mock `midstream` mode (env-only today) — rejected to keep the demo zero-new-code | the boundary is documented and code-pinned (`routing/dispatch.ts` `guardedStream` — error event, never re-routing/splice) and the SSE shapes are in `FLOW.md` |
| **unusable output** | **kept in the set (B3), but it is the one row demoed as "explained, not demonstrated"** — there is no per-request trigger: the assistant's output cap is server-fixed (500 tokens) with a grounding prompt that demands 2–5 sentences, and the mock answers long | the guard is code-pinned (`routes/assistant.ts` unusable-output branch), its billing asymmetry is documented, and refusal copy is env-configured; a mock `short` mode would make it on-demand and is the one candidate to add later |
| upstream outage (B8) and `ROUTING_CHAIN` (A7) | kept, but they are **operator scenes, not assessor clicks** — both need an env change + container restart (`OPENROUTER_BASE_URL` → dead port; `ROUTING_CHAIN` + `MOCK_FAILURE_MODE`) | listed in the runbook below; see the `ROUTING_CHAIN`/hung-backend traces already recorded in the decision log (§4) |

### 8.3 Two tiers for running the set

| tier | who | how |
|---|---|---|
| 1 — assessor-driven | any issued key, Postman/curl only | all of A (minus A7) and B1–B7: payloads are fixed, responses are the evidence, Observability replays each decision |
| 2 — operator scenes | the deployer, env → `docker compose up -d` → fire → revert | B8 (dead base URL), A7 fallback demo (`ROUTING_CHAIN=mock,openrouter-tier-a` + `MOCK_FAILURE_MODE=hang/fail`), and B3 if a mock `short` mode is ever added |

Tier 2 exists for the recorded walkthrough where cuts can hide the restart;
tier 1 is what an assessor runs independently. The full case coverage lives
in `RULES.md` (routing), `FLOW.md` (request path + failure shapes) and
`EVALUATION.md` (measured), so nothing in the narrowed set stands alone.