# Technical Report — Mini Inference Router

**TL;DR — one container, measured.** A streaming gateway (bearer-key auth →
fail-closed quota → rule-based routing → per-request metering) carrying one
capability, a support assistant (lexical retrieval over Bitext, calibrated
refusal), served by one Fastify process that also serves the React console.
Three backends — two real OpenRouter tiers + a scripted-failure mock — with
one confidence signal making two decisions (refuse below 0.48, capable-tier
swap below 0.55). Measured on 30 held-out cases through the real request
path: tier A = 87% intent, ~506 ms, $0.0038/30 cases; tier B = 87% intent,
+0.73 groundedness, 3× latency and 11.6× cost — so tier A carries the bulk
and tier B takes weak-retrieval/complex turns. Everything here is
re-runnable: `npm run eval`, and [`RUNBOOK.md`](RUNBOOK.md)'s curl suite.

Brief for the assessors: the decision log ([`DECISIONS.md`](DECISIONS.md)) was
written **before** any code; this report records what was measured afterwards,
where the numbers changed my mind, and where scope grew deliberately while
building — each growth stated with its reason (D11–D15).

## 0. Deliverables

| deliverable                                        | value                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub repository** (source + all documentation) | <https://github.com/nadhiffarizi/inference-router> — docs live in [`docs/`](.): this report, [`DECISIONS.md`](DECISIONS.md) (decisions argued before code), [`RULES.md`](RULES.md) (routing rationale), [`FLOW.md`](FLOW.md) (request path + failure shapes), [`EVALUATION.md`](EVALUATION.md) (measured A/B), [`DEPLOY.md`](DEPLOY.md) (deploy runbook), [`demo.postman_collection.json`](demo.postman_collection.json) (the section-8 case set, importable) |
| **Deployed URL**                                   | <https://router.kreasiodigital.com> — health: [`/v1/health`](https://router.kreasiodigital.com/v1/health) (`{"status":"ok"}`); self-hosted: Docker + NGINX + Cloudflare TLS per [`DEPLOY.md`](DEPLOY.md)                                                                                                                                                                                                                                                          |
| **Console credentials**                            | The login page lists the account emails only (no passwords shown in the app). Passwords, documented here only: `team@demo.local` / `mekari-demo-2026` (product team view) · `admin@demo.local` / `mekari-demo-2026` (adds cross-tenant Observability) · `zero@demo.local` / `mekari-demo-2026` (product view on the `quota-zero` tenant — its Playground 429s on the first message)                                                                               |

The rest of [`docs/`](.) — one authoritative home per topic; this report
cites what it needs inline, and the map below is the whole set:

| doc | what it is |
| --- | --- |
| [`DECISIONS.md`](DECISIONS.md) | the decision log, written **before** any code — D1–D19, each with its reason and what was rejected (index table at its top) |
| [`RULES.md`](RULES.md) | routing rationale: every rule, threshold and override, mirroring `routing/rules.ts` |
| [`FLOW.md`](FLOW.md) | one request walked end to end — entry gates, routing, fallback, SSE shapes, line-referenced |
| [`EVALUATION.md`](EVALUATION.md) | the measured A/B, per case |
| [`RUNBOOK.md`](RUNBOOK.md) | payload-level curl/Postman runbook for every case in section 8 (formerly this report's §10) |
| [`DEPLOY.md`](DEPLOY.md) | deploy runbook (Docker + NGINX + Cloudflare) |
| [`demo.postman_collection.json`](demo.postman_collection.json) | the section-8 case set, importable |

## 1. What was built

One system, four pieces:

1. **Gateway** (Fastify/TypeScript) — the assessed product. Bearer-key auth →
   fail-closed quota → rule-based routing → backend adapters → metering →
   SQLite. Streaming everywhere (SSE), full turn traces stored.
2. **Support assistant** — a _capability inside_ the gateway, not a second
   service: retrieval → confidence → (refuse | route) → grounded answer +
   intent, on the same auth/quota/metering path as plain chat. Optional
   caller-declared `sessionId` groups turns into sessions (grouping only —
   never model context; every turn is answered on its own, section 6).
3. **Console** (React/Vite, shadcn-style design system) — accounts (session
   login, no JWT), role-scoped sidebar: product team sees `Playground ·
API Keys · Usage`; admin is a tenant like any other plus one extra menu,
   `Observability`: fleet usage, per-key breakdown, the activity feed
   (openrouter-style: one row per gateway call), and trace/session viewers
   (Langfuse-style: question, answer, retrieval, routing plan, metering per
   turn), all from stored turn traces.
4. **Eval harness** (`eval/` workspace, D8) — 30 held-out Bitext cases fired
   through the _real_ gateway path (`POST /v1/support-assistant`, backend
   pinned via `body.backendPin` so auth, quota and metering are exercised, not
   bypassed), then an LLM-as-judge scores groundedness against the retrieved
   context. One command runs it end to end: `npm run eval` (config A = tier A
   pinned, config B = tier B pinned, then the A/B comparison renders
   [`EVALUATION.md`](EVALUATION.md)); raw per-case results — every answer,
   confidence, token count, failure and judge comment — land in
   `eval/results/`. There is no separate test endpoint: the harness drives the
   same routes a product team would ([`RUNBOOK.md`](RUNBOOK.md) covers the single-request
   equivalents).

## 2. Routing: the rules and why

Two real backends through OpenRouter + a scripted mock:

| backend | model                          | measured avg latency | measured cost/30 cases |
| ------- | ------------------------------ | -------------------- | ---------------------- |
| tier A  | `google/gemini-2.5-flash-lite` | ~506 ms              | $0.00383               |
| tier B  | `anthropic/claude-haiku-4.5`   | ~1569 ms             | $0.04449               |
| mock    | scripted latency/failure       | configured           | $0                     |

Rules (first match wins; inputs are signals the request already produced) —

1. **Refuse gate (assistant):** retrieval confidence < 0.48 → no model call.
2. **Tier A** for simple-shape questions with strong retrieval.
3. **Tier B** for weak retrieval (ambiguity → worth stronger reasoning) or
   complex questions (long / multi-clause / comparison wording).
4. **Fallback:** on upstream error, stall, or a stream that ends with zero
   content → next candidate. Fallback applies
   until the first content delta; after that a mid-stream fault is surfaced as an
   explicit `error` event rather than re-routed, because re-routing
   mid-answer would splice or duplicate content.

Every choice is written to `routing_decisions` (candidates, action, reason)
and rendered in the console — "recorded and inspectable" is a table, not a
log file. The full rationale, thresholds, and worked examples:
[`RULES.md`](RULES.md).

**Why these rules are defensible, not arbitrary:** each one maps to a measured
trade-off from section 4. Tier B costs 11.6× more for the same intent accuracy — so
"capable tier for _ambiguous or complex_ requests only" is a cost/quality
position, not a preference. The stall→fallback threshold exists because a
production proxy kills long requests anyway (learned operating an
OpenRouter-backed app: stalled upstreams turned into 524s); a gateway should
fail _over_ before the proxy fails _down_.

## 3. Retrieval and the confidence signal

Lexical (MiniSearch, fuzzy 0.3, question/intent boosted) over a 324-row
intent-stratified slice of Bitext; 30 further rows held out for eval. No
embeddings: OpenRouter exposes no embedding endpoint and this is the honest
budget line for one day (see D7). Iterated with measurement, not vibes:

| iteration | change                                                    | intent accuracy |
| --------- | --------------------------------------------------------- | --------------- |
| v1        | 4 rows/intent, fuzzy 0.2                                  | 63%             |
| v2        | 8 rows/intent                                             | 60%\*           |
| v3        | 12 rows/intent + fuzzy 0.3 + floor recalibrated 0.42→0.48 | **87%**         |

\*new held-out slice — not directly comparable, kept for the record.

**Confidence is calibrated from data, not tuned to look nice** — on-KB
questions and off-KB questions were scored separately (see
`gateway/src/scripts/retrievalProbe.ts`): v3 separates on-KB (0.56–0.81) from
off-KB (0.12–0.44), and the refusal floor sits at 0.48 between them. One
confidence signal drives two decisions at two thresholds: the refusal floor
(`RETRIEVAL_REFUSE_BELOW`, 0.48) asks _answer vs refuse_, and the tier-B swap
(`RETRIEVAL_TIER_B_BELOW`, 0.55) asks _tier A vs tier B_ — the band
`[0.48, 0.55)` is "answered, but ambiguous", documented in `RULES.md`.

The refusal path is a designed outcome, not an error: `refused: true` with the
reason, metered as a served-but-zero-cost request. Unusable model output
(empty/trivially short) is refused the same way.

## 4. Evaluation

30 held-out cases through the **real request path** (the eval pins a backend
via `backendPin` and still pays auth, quota, metering). Answer quality graded
by LLM-as-judge (same-key direct call, 1–5 groundedness against retrieved
context) — judge comments per case land in `eval/results/`.

| metric                         | A (tier A)   | B (tier B)     | better |
| ------------------------------ | ------------ | -------------- | ------ |
| intent accuracy                | 87%          | 87%            | tie    |
| refusal rate on held-out cases | 0%           | 0%             | —      |
| error rate                     | 0%           | 0%             | —      |
| avg / p95 latency              | 506 / 757 ms | 1569 / 2132 ms | A      |
| total cost (30 cases)          | $0.00383     | $0.04449       | A      |
| avg groundedness               | 3.37         | 4.10           | **B**  |

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

## 5. The request path — the functions the gateway calls, and how each failure is handled

The condensed walkthrough; [`FLOW.md`](FLOW.md) carries the same walk with
every line reference expanded.

```
client ──POST /v1/{chat|support-assistant}──►
  ① schema validation   (400 invalid_input)
  ② authenticate()      (401 unauthorized · 429 quota_exceeded · 503 quota_uncertain)
  ③ capability branch   chat: build messages · assistant: retrieval → confidence → refuse?
  ④ choosePrimary/primaryReason → plan = [primary, the other real tier]
  ⑤ openWithFallback(plan) — walk candidates until the first content delta
  ⑥ SSE: meta → delta… → (error?) → final
  ⑦ settle-up: unusable-output guard → recordRequest (metering) → bumpQuota
every path writes: routing_decisions row + requests row
```

**Stage 1 — entry gates, all before any model.** Fastify's declared JSON
schema (`routes/chat.ts`, `routes/assistant.ts`) rejects a bad body before
any handler runs → **400 invalid_input** with per-violation details
(`additionalProperties: false`, >4000 chars). Then the `authenticate` hook
(`plugins/auth.ts`) does identity + tenancy + quota in one place: `Bearer` →
`sha256` lookup (`api_keys`, plaintext only stored hashed) → **401** on no
match; one key = one tenant. `checkQuota` (`lib/quota.ts`) enforces three
counters on a fixed UTC-day window — requests, tokens, USD spend (spend is
summed from the `requests` metering rows: one source of truth for cost). The
fail-closed subtlety: `checkQuota` **throws** when the DB is unreadable, and
the auth layer surfaces that as **503 quota_uncertain** — a gateway that
cannot _verify_ quota must not serve blind. Both endpoints inherit this gate
because it is a pre-handler hook.

**Stage 2 — the capability branch, the only place the endpoints differ.**
`/v1/chat` builds `[system prompt, user message]`. `/v1/support-assistant`
runs retrieval first (`rag/kb.ts`): MiniSearch lexical top-k, an asymptotic
squash of the best hit's score, blended with intent concentration — two
numbers, `confidence` and `detectIntent`, exist before any model is chosen.
Then the refuse gate: `confidence < 0.48` (`config.assistant`) → **no model
is called**; the gateway streams the refusal like a served turn
(`backend: "none"`, `blocked_policy` decision row, `bumpQuota(tenant, 0)` —
a request slot consumed, zero tokens).

**Stage 3 — route plan (`routing/rules.ts`), first match wins.**
`choosePrimary`/`primaryReason` evaluate cheap local signals — weak-retrieval
band `[0.48, 0.55)` → tier B; complexity (length, ≥2 hint words, multiple `?`)
→ tier B; else tier A. The plan is always `[primary, the other real tier]` —
cross-tier fallback is baked into every request. Overrides: `backendPin`
puts a pinned adapter first (validated against the registry — unknown id →
**400** with the allowed ids, never silently ignored); `ROUTING_CHAIN` env
reorders the plan for demos. The mock is never picked by policy.

**Stage 4 — dispatch (`routing/dispatch.ts`), walk the plan until the first
content delta.** For each candidate: start the adapter's `stream()` generator
and race chunks against the adapter timeout (A 8s, B 20s, mock 6s) via
`nextWithTimeout` — a _router-level_ guard on top of the adapter's own
`AbortController`, after a probe proved a generator awaiting an internal
`sleep` ignores aborts. First delta → `served`
(`fallbackTriggered` = any earlier step failed); a stream that **completes
with zero deltas** is not a success — the step is marked `abandoned` and the
next candidate serves, so a success-shaped empty stream can't burn the plan.
Error/timeout →
`failed`, the abandoned generator is finalized (fetch body freed),
next candidate. Plan exhausted → **502 backend_unavailable** with the full
plan in the body. The retry boundary is deliberately **first content
delta**: after
that, `guardedStream` keeps per-chunk racing (a backend going silent
mid-answer becomes an explicit `error` SSE event, outcome `failed`) but is
**never re-routed** — re-routing mid-answer would splice or duplicate
content: correct-looking and wrong is worse than visibly broken.

**Stage 5 — stream out (`lib/sse.ts`), then settle up.** The stream is a
four-event protocol: `meta` → `delta…` → (`error?`) → `final`. `meta` — the
_routing receipt_ — arrives first, before any text: requestId, the winning
`backend`, `fallbackTriggered`, and the full `routingPlan` with each step's
`action` and reason. The assistant's `meta` adds retrieval + confidence +
intent; when the refuse gate fires, `meta` is all the client ever gets (no
delta at all). That's why the Playground renders "tier A, fallback fired"
live, mid-stream. Then `delta…`, then `final` with metering (`model, tokens,
latencyMs, ttftMs, estimatedCostUsd, costSource — provider-reported when
OpenRouter supplies usage, ~4-chars/token estimate otherwise`). Full payload
anatomy of `meta`: [`FLOW.md`](FLOW.md), "The `meta` event — the routing
receipt". After the stream settles:

1. Unusable-output guard: an answer under 15 chars becomes `refused: true` —
   a degraded backend can't eat the tenant's request allowance, but its
   tokens and cost stay on the `requests` row (the call happened), and the
   USD budget reads those rows.
2. `recordRequest` meters one row per turn (tokens, latency, TTFT, cost,
   outcome `ok|refused|failed`, full trace for replay). Metering never blocks
   the hot path; a failed metering is logged loudly, never fatal.
3. `bumpQuota(tenant, tokens)` after the fact.
4. `routing_decisions` row per plan step (`served`/`failed`/`abandoned`/
   `blocked_policy`) — the decision log the console renders.

**The failure map** (every failure, which status, retried or not):

| stage        | failure                                  | status / behaviour                                                        | retried?                           |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| schema       | bad body                                 | 400 `invalid_input`                                                       | no                                 |
| auth         | missing/unknown key                      | 401                                                                       | no                                 |
| auth         | over quota                               | 429 + `limits`/`used`/`reset`                                             | no                                 |
| auth         | can't verify quota                       | 503 `quota_uncertain`                                                     | no — fail closed                   |
| refusal gate | confidence < 0.48                        | served refusal, cost 0, outcome `refused`                                 | never (a decision, not an error)   |
| validation   | unknown `backendPin`                     | 400 with the allowed ids                                                  | no                                 |
| dispatch     | candidate errors / stalls / zero-delta completion | next candidate `served`, `fallbackTriggered: true`                  | yes, until first content delta     |
| dispatch     | every candidate failed                   | 502 `backend_unavailable` + full plan                                     | no                                 |
| streaming    | fault after first byte                   | explicit `error` SSE event, outcome `failed`                              | **never** — no mid-answer re-route |
| output       | unusable model answer                    | converted to refusal; request/token quota not charged, USD spend recorded | caller retries                     |

All failures share one body shape: `{error: {code, message, details}}` with
the correct status; nothing hangs (per-chunk timeout), nothing reports
success for a broken answer. Console-side violations (role/tenancy) are
server-enforced `403`, not hidden in the UI; the eval judge degrades honestly
(absent key printed, not fabricated numbers).

Design idea that ties the path together: **everything before the model is
cheap and enforced; everything after first byte is honest and billed.**

## 6. Scope: what was cut, and what deliberately grew

Cut deliberately rather than half-build (**still cut**):

- Conversation history / multi-turn model memory — **each request is answered
  from exactly one turn**. `sessionId` groups traces for observability only
  and is never injected as context, so a follow-up like _"and what about the
  second item?"_ finds no prior state and must be asked standalone. The
  boundary is D10's cut, restated in D15.
- Full RBAC — no users × permissions matrix; identity is one role bit on a
  tenant-scoped account (D11).
- Sliding-window quotas (fixed daily window), retries beyond one fallback hop,
  WebSocket, vector retrieval / reranking, cost-calibration wizard.

Measured limitation accepted on the cost line (the "metering recorded
accurately" axis): when OpenRouter streams without a `usage` frame, the
fallback estimate fills prompt tokens but leaves completion tokens at 0 even
though the answer was streamed and fully counted for the caller — so the
estimate under-bills the completion half rather than inventing precision, and
`costSource` on the `final` event says `estimate` when it happens. A later
empty `usage` frame would also overwrite cost with an estimate. Both are
accepted for the demo scale (provider-supplied `cost` was present on the
eval runs) rather than papered over; the calibration wizard above is the
deliberate cut that would close it.

Grew **on purpose** while building, each for a stated reason (full args in the
addendum D11–D15): console accounts + one-irreplaceable-key issuance flow
(makes tenancy and "enforces what each tenant is allowed" _demonstrable_
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

| #   | capability        | signals                                                                                                                               | primary                                          | reason string                                                    |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| 1   | chat              | simple: ≤240 chars, <2 hint words, ≤1 `?`                                                                                             | tier A                                           | `chat: simple question`                                          |
| 2   | chat              | complex: >240 chars OR ≥2 hint words (`because/however/difference/compare/explain/why/multiple/steps/detailed/policy/also`) OR >1 `?` | tier B                                           | `chat: complex question`                                         |
| 3   | support-assistant | conf ≥ 0.55 + simple shape                                                                                                            | tier A                                           | `assistant: retrieval confidence 0.80 (strong), simple question` |
| 4   | support-assistant | conf in [0.48, 0.55) — weak band, any shape; or complex shape                                                                         | tier B                                           | `assistant: retrieval confidence 0.50 (weak), simple question`   |
| 5   | support-assistant | `backendPin` = known backend id (`openrouter-tier-b`/-a/`mock`)                                                                       | pinned first, remaining real tier(s) as fallback | `pinned by request (eval A/B): ...`                              |
| 6   | any               | `backendPin` = unknown id                                                                                                             | —                                                | `400 invalid_input` with the allowed ids                         |
| 7   | any               | `ROUTING_CHAIN="mock,openrouter-tier-a"`                                                                                              | chain order first, leftovers appended            | `demo override (ROUTING_CHAIN position i): ...`                  |

Plan is always `[primary, the other real tier]` — cross-tier fallback baked
in; the mock is never picked by policy (only via 5/7).

**B. Refuse / fallback / fail**

| #   | case                        | trigger                                                                                                      | model called?  | outcome                                                                                           |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Refuse — low confidence     | conf < 0.48 (e.g. _"is the moon made of cheese?"_ ≈ 0.37)                                                    | none           | `refused: true`, cost 0, outcome `refused`, still consumes a request slot (`bumpQuota(id, 0)`)    |
| 2   | Refuse — complex + low conf | complexity high **and** conf < 0.48                                                                          | none           | refused before routing — tier B never reached even for complex questions                          |
| 3   | Fallback → next tier        | candidate error / stall past timeout (A 8s, B 20s, mock 6s) / empty stream, before first byte                | yes, then next | failed/abandoned step → next serves, `fallbackTriggered: true`; unreached tail recorded `skipped` |
| 4   | Quota — requests            | used+1 > requestsPerDay (`stress`: 3/day crossed over a few calls; `quota-zero`: 0/day denies on request #1) | none           | 429 `quota_exceeded` + `{limit, used, reset}`                                                     |
| 5   | Auth — unknown/foreign key  | wrong key; keys are SHA-256 at rest, one key = one tenant                                                    | none           | 401                                                                                               |
| 6   | Validation                  | empty message, >4000 chars, unknown field                                                                    | none           | 400 `invalid_input` (schema, `additionalProperties: false`)                                       |
| 7   | Upstream outage             | both tiers unreachable                                                                                       | tried both     | 502 `backend_unavailable` — full plan in body                                                     |

### 8.2 Full coverage vs this set — what is NOT demoed, and why

| dropped from the full table                                   | why we don't demo it                                                                                                                                                                                                                                                                                                                        | where the property is still evidenced                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| confidence boundary, conf **exactly** 0.48                    | retrieval confidence is a continuous score — no question reliably lands on 0.480; a boundary request would be luck, not a case                                                                                                                                                                                                              | the floor's two neighbourhoods ARE demoed: 0.37 refuses (B1), 0.50 routes weak (A4), 0.80 routes strong (A3); comparator cited (`rules.ts`, `assistant.ts` refusal gate)                                                   |
| quota — tokens/day and USD budget axes                        | same `checkQuota` code path with the identical 429 shape (`quota.ts:66-77`); demoing one axis is the whole fail-closed story, and the spend axis moves ~1e-4 USD per request — nearly invisible in a live demo (`budgetUsdPerDay: 0.7`)                                                                                                     | eval + observability data carry the axes; `FLOW.md` documents the counters                                                                                                                                                 |
| quota boundary semantics (#200 allowed, #201 denied)          | implicit in B4 — the check `used + 1 > limit` is quoted rather than staged as a separate scene                                                                                                                                                                                                                                              | `quota.ts` + the 429 body's own `limit`/`used` fields prove the semantics                                                                                                                                                  |
| quota concurrency race (two requests passing check-then-bump) | non-deterministic — needs a parallel fire to demonstrate, and its absence/presence is not a graded behaviour; single-instance SQLite check-then-bump is not atomic and is listed as a known limitation instead                                                                                                                              | section 7 limitation + `lib/quota.ts`; the atomic-reserve fix is proposed, deferred                                                                                                                                        |
| quota DB down → `503 quota_uncertain`                         | needs the in-process SQLite broken mid-run; there is no honest lever for it, and faking the DB failure would misrepresent more than it proves                                                                                                                                                                                               | branch is code-auditable (`lib/quota.ts:80-88`, `plugins/auth.ts`) and pinned by the test suite (`lib/quota.test.ts`) and the fail-closed posture is shown by B4–B6 instead                                                                                                   |
| missing Authorization header (401)                            | not dropped on merit — omitted as redundant with the unknown-key curl (B5); same fail-closed auth, same `{error:{code,message}}` shape                                                                                                                                                                                                      | the unknown-key case B5 demonstrates the identical shape; it is the trivially cheap extra curl if wanted                                                                                                                   |
| complexity boundary, 240 vs 241 chars                         | the boundary IS the rule shown by A1 vs A2 — a third request one character longer adds a scene without adding a failure shape; substring/case semantics cited from code (`rules.ts` `questionComplexity`)                                                                                                                                   | A1/A2 pair; boundary constants quoted                                                                                                                                                                                      |
| mid-stream fault (error after first byte)                     | no on-demand trigger exists: the mock can only fail _before_ first byte, and real provider faults aren't scriptable to a scene; would need a mock `midstream` mode (env-only today) — rejected to keep the demo zero-new-code                                                                                                               | the boundary is documented and code-pinned (`routing/dispatch.ts` `guardedStream` — error event, never re-routing/splice) and the SSE shapes are in `FLOW.md`                                                              |
| unusable output (answer < 15 chars after trim)                | **dropped — not demoable**: there is no per-request trigger; the assistant's output cap is server-fixed (500 tokens) with a grounding prompt that demands 2–5 sentences, and the mock answers long — a request cannot honestly be made to fail this way (a mock `short` mode would make it on-demand and is the one candidate to add later) | the guard is code-pinned (`routes/assistant.ts` unusable-output branch); its billing asymmetry (request/token counters not bumped, USD spend still recorded) is in section 5's failure map; refusal copy is env-configured |
| upstream outage (B7) and `ROUTING_CHAIN` (A7)                 | kept, but they are **operator scenes, not assessor clicks** — both need an env change + container restart (`OPENROUTER_BASE_URL` → dead port; `ROUTING_CHAIN` chain override). Fallback itself left that tier: with `MOCK_FAILURE_MODE=hang` deployed once (the mock is never picked by policy), the B3 scene fires per request via `backendPin:"mock"` — or the playground's "fault: on" toggle — no restart, and it is pinned by the dispatch test suite                                                                                                                                                        | listed in [`RUNBOOK.md`](RUNBOOK.md) (tier 2); see the `ROUTING_CHAIN`/hung-backend traces already recorded in the decision log (section 4)                                                                                                  |

### 8.3 Two tiers for running the set

| tier                | who                                                                                                                                         | how                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1 — assessor-driven | the key from `admin@demo.local` (console → API Keys; it stays revealable/copyable there) plus the two quota fixture keys, Postman/curl only | all of A **including A7/B3 fallback now** (pin the mock), plus B1, B2, B4, B5, B6: payloads are fixed, responses are the evidence, Observability replays each decision |
| 2 — operator scenes | the deployer, env → `docker compose up -d` → fire → revert                                                                                  | B7 (dead base URL), the `ROUTING_CHAIN` chain-order variant of the fallback scene                                               |
| 1.5 — fallback fired, no console | the A7/B3 scene above: `backendPin:"mock"` (playground: "fault: on") runs against the deployed box as-is — B3 is a tier-1 case on the live deployment |

Tier 2 exists for the recorded walkthrough where cuts can hide the restart;
tier 1 is what an assessor runs independently. The full case coverage lives
in `RULES.md` (routing), `FLOW.md` (request path + failure shapes) and
`EVALUATION.md` (measured), so nothing in the narrowed set stands alone.

## 9. The assessment criteria, mapped

The brief grades five things. This is where each is claimed — and where an
assessor should look to check the claim.

| criterion                                                                             | how this system satisfies it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | evidence                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Correctness of the request path** — auth, quota, streaming, failure behaviour       | Bearer auth is a SHA-256 lookup with one key = one tenant, no key = 401; quota is fail-closed **twice** (over limit → 429, check itself failing → 503 `quota_uncertain` rather than serving blind); streaming everywhere (SSE) with fallback bounded by first byte; every failure path returns a machine-readable `{error:{code,message,details}}` with the right status — and no path hangs (per-chunk router timeout)                                                                                                                                 | section 8.1 tables A/B; `plugins/auth.ts`, `lib/quota.ts`, `routing/dispatch.ts`, `lib/errors.ts`; section 5; the failure-path test suite — 16 tests via `npm run test --workspace gateway` — pins the fail-closed 503, the 429 shapes and the full fallback contract |
| **Routing and fallback** — reasoned rather than arbitrary, observable                 | Three cheap signals (complexity shape, retrieval confidence, capability), first-match-wins, each input a measured trade-off: tier B costs 11.6× tier A for +0.73 groundedness (section 4), retrieval separates on/off-KB classes (section 3); weak-retrieval band, refusal floor, and the two debug overrides (`backendPin`, `ROUTING_CHAIN`) are scoped and stated. Observable: every decision row is persisted and rendered — plan, action, reason per candidate                                                                                      | section 2, section 4; `docs/RULES.md`; `routing_decisions` table + console decision log                      |
| **Measurement** — tokens, latency, cost recorded accurately; quality with numbers     | One metering row per turn: prompt/completion tokens (provider-reported when OpenRouter supplies usage, estimate fallback, `costSource` distinguishes), e2e latency _and_ TTFT, USD cost — the same currency the quota enforces; quality measured, not asserted: 87% intent accuracy, LLM-judge groundedness 3.37 (A) vs 4.10 (B), latency p95, cost per 30 cases                                                                                                                                                                                        | section 4 table; `lib/metering.ts`; `docs/EVALUATION.md`                                                     |
| **Code structure and exception handling** — invalid input, timeouts, bad model output | Adapters are the single provider seam (a swap is a new adapter, not a rewrite); policy stays in one readable rule file; invalid input is schema-rejected (`additionalProperties: false` → 400, and unknown `backendPin` → 400 with allowed ids); timeouts enforced at two layers (adapter abort + router per-chunk guard) after a real bug proved the adapter's alone wasn't enough; bad model output (empty/<15 chars) converts to a designed refusal rather than a served garbage answer; upstream failures walk the plan then 502 with the full plan | section 5, section 6; `routing/rules.ts` header, `backends/types.ts`, section 8.2 dropped-rows rationale     |
| **Judgement** — what was built, what was skipped, and whether it was said so          | Every scope growth has a named decision (D11–D15), every cut is listed as _still cut_ (section 6), every known limitation is stated plainly (section 7), and the demo itself was narrowed explicitly with per-row reasons for what is not demoed (section 8.2) — including the two triggers that don't exist today (mid-stream fault, unusable output)                                                                                                                                                                                                  | sections 6–8; `docs/DECISIONS.md`; this report's section 3 iterated-with-measurement framing                 |

## 10. How to verify it live

Every case in section 8 — including the two not-demoed triggers of 8.2, whose
boundaries are pinned in code and by the test suite — is executable without
any console: [`RUNBOOK.md`](RUNBOOK.md) carries the whole runbook (setup +
key fixtures, tier-1 assessor cases, tier-2 operator scenes), or import
[`demo.postman_collection.json`](demo.postman_collection.json) and set
`baseUrl` / `apiKey`. The console **Playground** renders the same requests
visually (live X-ray: routing receipt, stream, metering).
