# Live demo runbook — payload + curl per chosen case

The case definitions and the "why this set" rationale live in
[`REPORT.md`](REPORT.md) §8 (8.1 = the chosen set, 8.2 = what is NOT demoed,
8.3 = the two tiers). This file is the executable form of that set.
Postman equivalent: import
[`demo.postman_collection.json`](demo.postman_collection.json) and set the
collection variables `baseUrl`, `apiKey` — the fixture key for the quota case
is pre-filled.

**Which key the assessor uses: log in to the console as `admin@demo.local`
(password `mekari-demo-2026`, credentials in [`REPORT.md`](REPORT.md) §0), open
`API Keys`, and copy `ops-key` — it stays revealable/copyable on the card.**
That account's tenant has 500 req/day headroom for every tier-1 case, and the
same login gives Observability to verify the trail afterwards. The only
requests that use other keys are the quota cases, which have their own
fixtures:

```bash
# 1) base + key — the admin@demo.local key copied from console → API Keys
BASE=https://router.kreasiodigital.com          # or http://127.0.0.1:4000
KEY=sk_…the ops-key copied from admin@demo.local's key card
AUTH="Authorization: Bearer $KEY"
CT="Content-Type: application/json"
# fixtures for the quota case: STRESS crosses a 3 req/day limit over a few
# calls; ZERO (quota-zero tenant, 0 req/day) denies on request #1 — see B4/B4b
STRESS=sk_stress_key_0000000000000000
ZERO=sk_zero_key_0000000000000000
```

Reading the responses: streaming routes answer with SSE — the first
`event: meta` carries `backend`, `fallbackTriggered` and the full
`routingPlan` (the pills an assessor needs); `event: final` carries metering
and quota. Non-stream failures (401/400/429/502) come back as plain JSON.

## Tier 1 — assessor-replayable (Postman/curl only)

```bash
## A1 — chat, simple question → tier A
curl -sN "$BASE/v1/chat" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"what is your refund window?"}'
#   meta.routingPlan[0].reason  = "chat: simple question", backend openrouter-tier-a

## A2 — chat, complex question → tier B
curl -sN "$BASE/v1/chat" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"Explain why a gateway uses fallback, compare two failure modes, and list the detailed steps an operator follows when the policy also fails."}'
#   reason "chat: complex question", backend openrouter-tier-b

## A3 — assistant, strong retrieval + simple → tier A (conf ≈ 0.80)
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?"}'
#   meta.retrieval.confidence ≈ 0.80 (strong); plan [tierA, tierB]

## A4 — assistant, weak band [0.48, 0.55) → tier B (conf ≈ 0.50)
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"can I sell items on the marketplace?"}'
#   meta.retrieval.confidence ≈ 0.50 → reason "confidence 0.50 (weak), simple question" → tier B first

## A5 — backendPin: pinned tier B first, tier A fallback behind it
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?","backendPin":"openrouter-tier-b"}'
#   plan[0].backendId = openrouter-tier-b, reason "pinned by request (eval A/B): …"

## A6 — unknown backendPin → 400 (validated, never silently ignored)
curl -s "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?","backendPin":"ghost"}'
#   {"error":{"code":"invalid_input","details":{"allowed":[…]}}}  — HTTP 400

## B1 — policy refusal: conf < 0.48, no model call, cost 0
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"is the moon made of cheese?"}'
#   meta: refusal true, backend "none"; final: refused true + reasoning;
#   request slot consumed (bumpQuota(id, 0))

## B2 — complex shape + low conf → refused before routing, tier B never reached
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"explain why dragons hoard gold, using multiple reasoning steps"}'
#   ~4 hint words → complex shape; conf ≈ 0.17 (measured) < 0.48
#   meta: refusal true, plan [{backendId:"none", action:"blocked_policy"}]

## B4 — quota: the 3-requests/day fixture tenant; fire until the 429
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "request $i → HTTP %{http_code}\n" \
    "$BASE/v1/support-assistant" -X POST \
    -H "Authorization: Bearer $STRESS" -H "$CT" \
    -d '{"message":"how do I track my package?"}'
done
#   Use STRESS key for the demo sk_stress_key_0000000000000000
#   the request that crosses the limit → 429 quota_exceeded with
#   {limit, used, reset:"UTC midnight"}; counters are UTC-daily, so the exact
#   step at which it lands depends on today's use of the fixture key — a fresh
#   midnight gives exactly 3 × 200 then 429 on the 4th.

## B4.1 — quota, instant variant: the quota-zero fixture denies on request #1
curl -s "$BASE/v1/support-assistant" -X POST \
  -H "Authorization: Bearer $ZERO" -H "$CT" -d '{"message":"hi"}'
#   Use ZERO key for the demo sk_zero_key_0000000000000000
#   HTTP 429 quota_exceeded on the very first call (used+1 > 0) — the same
#   fail-closed behaviour B4 walks up to, with no sequence needed. Console
#   demo: log in as zero@demo.local, connect the Playground with the ZERO
#   key, send one message → quota_exceeded in the chat bubble and the X-ray.

## B5 — auth fails closed: unknown key, and no header at all (same shape)
curl -s "$BASE/v1/support-assistant" -X POST \
  -H "Authorization: Bearer sk_not_a_real_key_at_all" -H "$CT" -d '{"message":"hi"}'
#   HTTP 401 {"error":{"code":"unauthorized","message":"Unknown API key."}}
curl -s "$BASE/v1/support-assistant" -X POST -H "$CT" -d '{"message":"hi"}'
#   HTTP 401 — missing header, identical body shape

## B6 — validation: >4000 chars, and an unknown field (schema is strict)
curl -s "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d "{\"message\":\"$(printf 'x%.0s' $(seq 1 4001))\"}"
#   HTTP 400 invalid_input (length violation)
curl -s "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"hi","unexpectedField":true}'
#   HTTP 400 invalid_input (additionalProperties: false)
```

Verify the trail afterwards: **Observability** (admin) or **Usage → routing
decisions** shows each fired request as a decision row — the plan, actions and
reasons must match what the response just streamed.

## Tier 2 — operator scenes (env change → restart → fire → revert)

```bash
## A7 & B3 — fallback: mock first, scripted stall → router timeout → tier A
#   in docker-compose.yml environment add:
#     ROUTING_CHAIN: "mock,openrouter-tier-a"
#     MOCK_FAILURE_MODE: "hang"          # or "fail" for the hard-error variant
docker compose up -d
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?"}'
#   meta.routingPlan = [mock failed "…timeout", openrouter-tier-a served],
#   fallbackTriggered: true
#   → then remove both lines and: docker compose up -d

## B7 — upstream outage: both real tiers unreachable → 502, never a hang
#   temporarily set: OPENROUTER_BASE_URL=http://127.0.0.1:9
docker compose up -d
curl -sN "$BASE/v1/support-assistant" -X POST -H "$AUTH" -H "$CT" \
  -d '{"message":"how do I cancel my order?"}'
#   502 {"error":{"code":"backend_unavailable",…,"details":{"plan":[both failed]}}}
#   → revert the base URL and: docker compose up -d
```

The same requests also run from the console **Playground** for the visual
rendering (meta → delta → final with the routing X-ray); this runbook's value
is that the assessor can drive every tier-1 case without any console at all.