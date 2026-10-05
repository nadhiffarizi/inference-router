# Live demo runbook — the assessment's case set, executable

The case definitions and the "why this set / why the rest isn't demoed"
rationale live in [`REPORT.md`](REPORT.md) §8. This file is the executable
form: payload + curl per case, the console equivalents, and what to look at
in each response. Postman equivalent: import
[`demo.postman_collection.json`](demo.postman_collection.json) — the request
names here match its request names one to one.

## Setup — one time

**Key:** log in to the console <https://router.kreasiodigital.com> as
`admin@demo.local` (password `mekari-demo-2026`, credentials in
[`REPORT.md`](REPORT.md) §0), open **API Keys**, and **reveal + copy
`ops-key`** — the full plaintext, not the masked hint. That tenant has 500
req/day — headroom for every case here. The same login also gives
**Observability**, which is where you verify each case's decision trail.
Every account login resets the playground — the intended flow is always:
**log in → API Keys → copy key → Playground → connect → chat.**

```bash
# base + key — the ops-key copied from admin@demo.local's key card
BASE=https://router.kreasiodigital.com          # or http://127.0.0.1:4000
KEY=sk_…the ops-key copied from API Keys
AUTH="Authorization: Bearer $KEY"
CT="Content-Type: application/json"
# quota-fixture keys (see B4/B4.1): STRESS crosses its 3 req/day limit over a
# few calls (fresh at UTC midnight); ZERO denies on request #1, always
STRESS=sk_stress_key_0000000000000000
ZERO=sk_zero_key_0000000000000000
```

Postman: set the collection variables `baseUrl` and `apiKey` (collection ⚙ →
Variables) with the values above.

**Reading streaming responses:** the two product routes answer with SSE —
`event: meta` (the *routing receipt*: `backend`, `fallbackTriggered`, the
full `routingPlan` with per-candidate `action` + `reason`; assistant adds
`retrieval` + `intent`) → `event: delta`… → `event: final` (metering:
model/tokens/latency/ttft/cost + `costSource`, plus live `quota`) →
`event: stream_end`. Non-stream failures (400/401/429/502) come back as
plain JSON. In Postman, read the raw body; for the live-token view use
`curl -sN` or the console Playground.

---

## A — routing picks (what chose the backend, and why)

### A1 — chat, simple shape → tier A

```bash
curl -sN "$BASE/v1/chat" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"what is your refund window?"}'
```
Expect: `meta.backend = openrouter-tier-a`, `fallbackTriggered: false`,
`routingPlan[0].reason = "chat: simple question"`, tail step `skipped`
("not reached — openrouter-tier-a answered first").

### A2 — chat, complex shape → tier B

```bash
curl -sN "$BASE/v1/chat" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"Explain why a gateway uses fallback, compare two failure modes, and list the detailed steps an operator follows when the policy also fails."}'
```
Expect: `backend openrouter-tier-b`, reason `"chat: complex question"`
(length + hint words + multiple clauses). Slower — that's the measured
trade-off (§4 of the report), not a bug.

### A3 — assistant, strong retrieval + simple → tier A

```bash
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?"}'
```
Expect: `meta.retrieval.confidence ≈ 0.80` ("strong"), 5 retrieved entries,
`intent` with confidence, reason `"assistant: retrieval confidence 0.80
(strong), simple question"` → tier A.

### A4 — assistant, weak band [0.48, 0.55) → tier B

```bash
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"can I sell items on the marketplace?"}'
```
Expect: `confidence ≈ 0.50` → reason `"…confidence 0.50 (weak), simple
question"` → tier B first. This is the deliberate band: answerable, but
worth the capable tier.

### A5 — backendPin: pinned tier B first, tier A behind it

```bash
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?","backendPin":"openrouter-tier-b"}'
```
Expect: `plan[0] = openrouter-tier-b`, reason
`"pinned by request (eval A/B): …"`, tier A `skipped`. (This same mechanism
is what the eval harness drives A/B with.)

### A6 — unknown backendPin → 400 (validated, never silently ignored)

```bash
curl -s "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?","backendPin":"ghost"}'
```
Expect: HTTP 400 `invalid_input` with `details.allowed = ["openrouter-tier-a",
"openrouter-tier-b", "mock"]`.

### A7 & B3 — fallback: the pinned mock hangs → router timeout → tier A rescues

The deployed box runs `MOCK_FAILURE_MODE=hang` **permanently**. Policy
routing *never* picks the mock, so normal traffic is untouched — the lever
only arms when you deliberately pin it. This is the fallback-in-one-request
scene; no env change, no restart.

```bash
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?","backendPin":"mock"}'
```
Expect: ≈6s of scripted stall, then
`meta.routingPlan = [mock → failed ("mock stalled 6000ms between chunks
(router timeout)"), openrouter-tier-a → served, openrouter-tier-b →
skipped]` and `fallbackTriggered: true`. The `final` metering's `ttftMs`
honestly includes the whole stall (~7s) — that's the caller-perceived story.

**Console twin (the video-friendly one):** Playground → assistant mode →
flip the **`fault: fallback`** toggle next to the capability picker → send →
the X-ray shows the chain live: mock failing, tier A serving, the fallback
badge firing — then click the bubble to open the trace and read the same plan
from the decision row.

Env-level variant (operator only, §8.1 row 7): `ROUTING_CHAIN:
"mock,openrouter-tier-a"` in docker-compose → `docker compose up -d` makes
the mock first for **every** request with no pin — demonstrating the
chain-order override rather than a per-request pin. Remove it afterwards
(it costs every request a 6s stall).

---

## B — refuse / fallback-fail / quota / auth / validation

### B1 — policy refusal: confidence < 0.48, no model call, cost 0

```bash
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"is the moon made of cheese?"}'
```
Expect: HTTP 200 (a refusal is a *served decision*, not an error);
`meta.refusal = true`, `reason = "low_retrieval_confidence"`,
`backend = none`, measured confidence ≈ 0.37; `final.refused = true` with
`reasoning = "retrieval confidence 0.37 < floor 0.48"` and the policy answer
copy. No model is ever called; the request still consumes a request slot
(`bumpQuota(id, 0)`), cost 0.

### B2 — complex shape + low confidence → refused before routing

```bash
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"explain why dragons hoard gold, using multiple reasoning steps"}'
```
Expect: refusal with plan `[{backendId:"none", action:"blocked_policy",
reason:"retrieval confidence 0.17 below refusal floor"}]` — tier B is *never
reached* even though the shape is complex: the gate runs before the router.

### B4 — quota ramp: the 3-requests/day fixture tenant

```bash
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "request $i → HTTP %{http_code}\n" \
    "$BASE/v1/support-assistant" -X POST \
    -H "Authorization: Bearer $STRESS" -H "$CT" \
    -d '{"message":"how do I track my package?"}'
done
```
Expect: three HTTP 200s, then **HTTP 429 `quota_exceeded`** with
`{limit, used, reset: "UTC midnight"}` in the body. Counters are UTC-daily:
on a fresh UTC day this lands exactly on the 4th call; later in the day the
429 arrives sooner (the fixture keeps what today used).

### B4.1 — quota, instant variant: the zero-limit fixture

```bash
curl -s "$BASE/v1/support-assistant" -X POST \
  -H "Authorization: Bearer $ZERO" -H "$CT" -d '{"message":"hi"}'
```
Expect: **HTTP 429 on the very first call** (`used+1 > 0`) — the same
fail-closed check B4 walks up to, with no sequence needed. Console twin:
log in as `zero@demo.local`, copy the quota-zero key from API Keys, connect
the Playground, send one message → `quota_exceeded` on the reply edge and in
the X-ray, your sent bubble intact.

### B5 — auth fails closed: unknown key, and no header at all

```bash
curl -s "$BASE/v1/support-assistant" -X POST \
  -H "Authorization: Bearer sk_not_a_real_key_at_all" -H "$CT" -d '{"message":"hi"}'
curl -s "$BASE/v1/support-assistant" -X POST -H "$CT" -d '{"message":"hi"}'
```
Expect: **HTTP 401** twice, identical body shape
(`unauthorized` — `Unknown API key.` / `Missing API key. …`).

### B6 — validation: the schema is strict, both axes

```bash
curl -s "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d "{\"message\":\"$(printf 'x%.0s' $(seq 1 4001))\"}"
curl -s "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"hi","unexpectedField":true}'
```
Expect: **HTTP 400 `invalid_input`** for both — a length violation with
per-field `violations`, and an unknown-field violation
(`additionalProperties: false`; Fastify's silent-strip default is explicitly
off — pinned by the HTTP-level test in
`gateway/src/routes/http-validation.test.ts`).

### B7 — upstream outage: every candidate dead → backend_unavailable, never a hang

**On demand (tier 1) — `pinStrict`:** the strict pin keeps ONLY the pinned
backend in the plan, so its failure exhausts the chain on the spot — the same
exhaustion path an env-level outage walks, no env change needed:

```bash
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?","backendPin":"mock","pinStrict":true}'
curl -sN "$BASE/v1/chat" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?","backendPin":"mock","pinStrict":true}'
```
Expect (both routes): ≈6s scripted stall, then a streamed
`event: error` with `{"error":{"code":"backend_unavailable", "message":"no
backend served the request: …", "details":{"plan":[{"backendId":"mock",
"action":"failed", …}]}}}` — no `meta` (nothing was served), then
`stream_end`. `pinStrict` without `backendPin` → 400. Console twin:
Playground toggle cycles `fault: off → fallback → outage`; "outage" runs
this exact scene in either capability.

**Env-level variant (operator):** both *real* tiers dead at once:

```bash
# temporarily set: OPENROUTER_BASE_URL=http://127.0.0.1:9
docker compose up -d
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?"}'
#   every candidate tried and failed (a `failed` step each, with its real
#   error), then: HTTP 200 + SSE error event … or the plain 502 shape:
#   {"error":{"code":"backend_unavailable",…,"details":{"plan":[both failed]}}}
#   → revert the base URL and: docker compose up -d
```
Expect: every candidate tried and failed (each a `failed` step with its real
error), then `backend_unavailable` with the full plan in the body — the
response always terminates; nothing hangs.

---

## Verify the trail afterwards

**Observability** (admin) or **Usage → routing decisions** shows every fired
request as a decision row — plan, actions and reasons must match what the
response streamed. The activity feed stamps rows with full
`date · time (local)`; the filter bar takes tenant/outcome/capability
dropdowns **plus a day-range** (calendar pickers; the range drives the table
*and* the charts above it). **The dispatch chain is also pinned by the test
suite** — `npm run test --workspace gateway` (22 tests) replays the
fail-closed 503, the 429 shapes, the unknown-field 400, and every fallback
branch without touching the network.