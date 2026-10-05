# Request flow — how a call travels through the gateway

One document that walks a single request end to end: entry gates, the
capability branch, routing, fallback, and settle-up. Code references are
clickable; this mirrors `rules.ts`, `dispatch.ts`, `routes/chat.ts` and
`routes/assistant.ts` exactly. Companion docs — the *why* for rules:
[`RULES.md`](RULES.md); choices made before the code:
[`DECISIONS.md`](DECISIONS.md); measured numbers: [`REPORT.md`](REPORT.md).

## The map

```
client ──POST /v1/{chat|support-assistant}──►
  ① schema validation   (400 invalid_input)
  ② authenticate()      (401 unauthorized · 429 quota_exceeded · 503 quota_uncertain)
  ③ capability branch
        chat      → messages built          ┐
        assistant → retrieve → confidence → ├─► ④ buildRoutePlan()
                  (refuse if < 0.48)        ┘         │
  ⑤ openWithFallback(plan)  — walk candidates until first byte
  ⑥ SSE to client:   meta → delta… → (error?) → final
  ⑦ post-stream: cost → unusable-output guard → recordRequest → bumpQuota
every path writes: routing_decisions row + requests row
```

---

## Stage 1 — Entry: schema, then auth, then quota (all before any model)

The request hits Fastify. The route declares a JSON schema
(`gateway/src/routes/chat.ts:16`, `assistant.ts:24`), so a bad body (missing
`message`, >8000 chars, unknown field via `additionalProperties: false`) is
rejected by the framework before any handler runs → **400 invalid_input** with
per-violation details.

Then `onRequest: authenticate` runs (`gateway/src/plugins/auth.ts`), which does
the three-layer enforcement in one hook:

1. **Identity:** `Bearer <key>` → `sha256(key)` → lookup in `api_keys` by hash
   (plaintext only stored hashed). No match → **401**. A key maps to exactly
   one tenant — that's the whole tenancy model.
2. **Tenant load:** tenant row joined by the key's `tenantId`.
3. **Fail-closed quota check** (`gateway/src/lib/quota.ts`), fixed UTC-day
   window, three counters:
   - `requestCount + 1 > requestsPerDay` → deny
   - `tokensTotal >= tokensPerDay` → deny
   - `usdSpend >= budgetUsdPerDay` → deny (USD spend is computed from the
     `requests` metering rows — one source of truth for cost,
     `quota.ts:47-51`)

   The subtlety: `checkQuota` **throws** if the DB is unreadable rather than
   returning `allowed: true` — the auth layer surfaces that as
   **503 quota_uncertain**. A gateway that can't *verify* your quota must not
   serve you blind. "Fail closed" is applied twice (deny-on-over-limit, and
   deny-on-can't-check).

Denials get a machine-readable body with `limits` + `used` +
`reset: "UTC midnight"` so the caller can show remaining quota without another
call.

Note the asymmetry: auth/quota live in a **pre-handler hook**, so both
endpoints inherit the identical gate. Nobody can call the assistant and skip
quota — it's the same path.

---

## Stage 2 — The capability branch (the only place the two endpoints differ)

### `/v1/chat` (`gateway/src/routes/chat.ts:50-59`)

Trivial: build messages `[system prompt, user message]`, set
`RouteContext = { capability: "chat", question }`. No retrieval — the
confidence signal doesn't exist for this capability.

### `/v1/support-assistant` (`gateway/src/routes/assistant.ts:50-91`)

Two extra things happen, and both happen *before* any model is chosen:

**a) Retrieval + confidence** (`gateway/src/rag/kb.ts:67-91`):

- MiniSearch lexical search over the KB slice, top-k results.
- `topHitStrength = 1 − 1/(1 + best/120)` — an asymptotic squashing of the raw
  BM25 score, calibrated so measured on-KB questions land ≥~0.62 and off-KB
  ≤~0.53.
- Blend with **intent concentration** (majority intent's share of total score):
  `confidence = topHitStrength * (0.5 + 0.5 * intentConfidence)`. This pushes a
  genuine match up and generic lexical mush down.
- Also emits `detectIntent` — the majority intent, which becomes the response's
  "detected intent".

**b) The refuse gate — first rule in the whole system, and it beats routing:**

```ts
if (confidence < 0.48)  // config.assistant.refuseBelowConfidence
```

→ **no model is called at all**. The response streams `meta {refusal: true,
reason, backend: "none", routingPlan: [blocked_policy]}` then `final {refused:
true, message, reasoning: "retrieval confidence 0.31 < floor 0.48", metering:
{model: "none", tokens: 0, cost: 0}}` — the refusal is a first-class routing
outcome, so the console's X-ray (routing pills, metering, "no intent applied")
replays it exactly like a served turn. It still writes a routing decision
(`backendId: "none", action: "blocked_policy"`) and a `requests` row with
`outcome: "refused"` — with the refusal text as the turn's `answer`, so the
session transcript replays what the user was actually told — and
`bumpQuota(tenant, 0)`: the refusal consumes a *request* slot but zero tokens,
because nothing was spent.

Why this ordering matters: the refusal is a **policy** decision, not a routing
decision. Choosing between tier A and tier B is meaningless if the gateway has
nothing to stand on.

---

## Stage 3 — Route plan: rules, not vibes (`gateway/src/routing/rules.ts`)

The router never calls an LLM to pick an LLM. It computes two cheap local
signals and does **first-match-wins**:

```
① Refuse gate (assistant only): confidence < floor 0.48  → REFUSE  [handled in the route, before this stage]
② Weak retrieval (assistant, floor ≤ conf < tierB-swap 0.55) → primary = tier B
③ Complexity:  long (>240 chars) · ≥2 hint words (because/however/compare/explain/policy/…)
               · multiple '?'             → tier B, else tier A
④ Plan = [primary, then the other real tier]   ← cross-tier fallback is BAKED IN, every request
```

(`choosePrimary`/`primaryReason`, `rules.ts:53-66`. The weak band is
`[RETRIEVAL_REFUSE_BELOW, RETRIEVAL_TIER_B_BELOW)` = `[0.48, 0.55)` — answered,
not refused, but an ambiguous match → tier *B* first, because the stronger
model is worth the cost when the grounding is shaky. The floor and the swap
threshold are deliberately different numbers: if they were equal, the band
collapses and the tier swap would be dead code (the gate consumes every weak
result before the router sees it).)

Three overrides worth knowing:

- **`backendPin`** (eval/debug): puts the pinned adapter first while keeping
  the rest of the plan as fallbacks — this is how the A/B eval runs tier A vs
  tier B *through* the real auth/quota/metering path instead of around it
  (`rules.ts:69-75`). Validated against the adapter registry first: an unknown
  id is a 400 `invalid_input` (with the allowed ids), not a silent ignore — a
  typo'd pin quietly routing by policy is correct-looking, wrong.
- **`ROUTING_CHAIN` env**: reorders the whole plan for demos
  (`"mock,openrouter-tier-a"`), without touching rules. Demo-only; unset in
  production.
- **The mock is never picked by policy.** It exists only to fail on demand.

Every plan entry carries a human-readable `reason` ("assistant: retrieval
confidence 0.80 (strong), simple question") — that string is what makes a wrong
route *debuggable* rather than arguable.

---

## Stage 4 — Dispatch: walk the plan until first byte (`gateway/src/routing/dispatch.ts`)

This is the fallback engine. For each candidate in order:

1. Start the adapter's `stream()` generator.
2. **Race the very first chunk against the adapter's timeout** (tier A 8s,
   tier B 20s, mock 6s) — `nextWithTimeout()`, `dispatch.ts:69-83`. This is a
   *router-level* guard layered on top of the adapter's own `AbortController`,
   because a probe proved a generator awaiting an internal `sleep` happily
   ignores a fetch abort — the route used to hang forever. Now the router
   itself can be the one that gives up.
3. Outcomes:
   - **First chunk arrives** → mark this candidate `served`, return its stream.
     `fallbackTriggered = (any earlier step failed)`.
   - **Chunk arrives but stream had already ended, no output** → `abandoned`,
     try next.
   - **Error / timeout** → `failed` with the actual error text, `iter.return()`
     finalizes the abandoned generator (frees the open fetch body),
     **next candidate**.
4. Plan exhausted → `ok: false` → route layer emits `error` SSE event
   `backend_unavailable` (**502-style**) with the full plan attached, and
   meters `outcome: "failed"`.

**The retry boundary is deliberately "first byte."** Once a backend has started
streaming *to the client*, dispatch is out of the loop; the served stream is
wrapped in `guardedStream` (`dispatch.ts:89-104`) which keeps per-chunk racing,
so a backend that goes silent mid-answer *fails as an error event* instead of
hanging. But it is **not re-routed** — re-routing mid-answer would splice or
duplicate content: correct-looking and wrong is worse than visibly broken.
That comment (`dispatch.ts:10-14`) is one of the defensible positions in the
codebase.

On the adapter side (`gateway/src/backends/openrouter.ts`): fetch with
`AbortController`, abort timer cleared the moment the first byte lands, final
SSE chunk carries `stream_options: { include_usage: true }` so **cost/token
metering comes from the provider's own numbers** when available
(`costSource: "provider"`), with a ~4-chars/token fallback estimate otherwise.

---

## Stage 5 — Streaming out, then settling up

The client sees SSE events in this exact shape (`gateway/src/lib/sse.ts`):

```
event: meta   → requestId, chosen backend, fallbackTriggered, full routingPlan,
                (assistant: retrieval entries + confidence + detected intent)
event: delta  → {text} … repeated, exactly what the model emitted
event: error  → only on mid-stream fault or total failure
event: final  → metering {model, tokens, latencyMs, ttftMs, estimatedCostUsd, costSource}
                quota {used, limits}
                (assistant: answer / refusal, retrieval, intent)
```

`meta` arrives *before any delta*, which is why the playground can render "this
will be served by tier A, fallback fired" live without waiting for the answer.

### The `meta` event — the routing receipt

`meta` is the first event of the stream: everything the gateway decided about
the request *before the model emitted a token*. It exists so a client can
render routing live instead of discovering the plan after the answer ends.

| event | arrives | carries |
|---|---|---|
| `meta` | first, **before any text** | which backend won, the routing plan, fallback info |
| `delta` | repeated | the answer text, chunk by chunk |
| `error` | only on a fault | structured `{code, message, details}` |
| `final` | last | metering: tokens, latency, TTFT, cost, quota remaining |

Payload (chat — `routes/chat.ts:82-88`):

```json
{
  "requestId": "3ba4c281-…",
  "backend": { "id": "openrouter-tier-b", "label": "Tier B · capable",
               "model": "anthropic/claude-haiku-4.5" },
  "fallbackTriggered": false,
  "routingPlan": [
    { "backendId": "openrouter-tier-a", "action": "failed",
      "reason": "upstream timeout" },
    { "backendId": "openrouter-tier-b", "action": "served",
      "reason": "chat: complex question" }
  ]
}
```

- `backend` — the adapter that won the dispatch walk.
- `routingPlan` — every candidate with its per-step `action` (`served` /
  `failed` / `abandoned` / `skipped`) and the human-readable `reason` the
  rules wrote — the same strings the console's decision log renders.
- `fallbackTriggered` — did an earlier candidate die so a later one served.

The support-assistant `meta` is the same plus the capability's context:
retrieval entries, `confidence` and the detected intent. When the refuse gate
fires, `meta` is all the client ever gets — `refusal: true`,
`backend: "none"`, plan `[{backendId:"none", action:"blocked_policy"}]`, no
`delta` at all (Stage 2b).

See one live:

```bash
curl -sN http://127.0.0.1:8787/v1/chat -X POST \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"message":"what is your refund window?"}'
# event: meta    ← the routing receipt, first
# event: delta   ← answer chunks
# event: final   ← metering
```

`meta` can arrive before the answer because dispatch resolves who serves
before streaming starts — the router always knows the winner first; when the
first candidate dies, `fallbackTriggered`/`failed` steps are what it knows
*instead of* an answer.

After the stream settles (`assistant.ts:164-218`):

1. **Unusable-output guard** (the brief's "model returns something unusable"):
   `answer.trim().length < 15` → convert to `refused: true` with the actual
   reason, meter it, **don't bump request/token quota** — a degraded backend
   can't eat a tenant's daily allowance (fail-closed, same principle as the
   refusal gate). What *is* charged: the model call really happened, so its
   tokens + cost are recorded on the `requests` row, and USD spend quota is
   computed from those rows — the budget reflects reality. Billing the
   failure but not re punishing the tenant's request allowance is deliberate.
2. **Metering:** one `requests` row per turn — tokens, latency, ttft (time to
   first token, null when nothing streamed), cost, outcome
   (`ok | refused | failed`), backend/model, key name, and the full turn trace
   (question, answer, retrieval JSON) so observability can *replay* a turn, not
   just count it. Metering failures are logged loudly, never crash a served
   request.
3. **Quota bump:** `bumpQuota(tenant, prompt+completion tokens)` — after the
   fact, outside the hot path. A failed bump is logged, not fatal.
4. `routing_decisions` row: the plan steps (`served` / `failed` / `abandoned` /
   `blocked_policy`), which backend won, `fallbackTriggered`.

---

## One worked trace, end to end

`POST /v1/support-assistant` `"how do I cancel my order?"`:

| step | what fires | result |
|---|---|---|
| schema | valid body | pass |
| auth | key → tenant, quota verified | pass |
| retrieval | conf **0.80**, intent `cancel_order` | above floor |
| rules | strong retrieval + simple question | plan = `[tierA, tierB]`, reason "retrieval confidence 0.80 (strong), simple question" |
| dispatch | tier A first chunk in ~500ms | `served`, fallbackTriggered=false |
| stream | meta → deltas → done(usage) | answer streams |
| settle | 0 tokens refusal? no → meter + bump | `final` with cost |

Same question, `"is the moon made of cheese?"`: conf **0.37** → refuse gate
fires at Stage 2b, plan never even built, zero model calls.

Fallback demo: `ROUTING_CHAIN="mock,openrouter-tier-a" MOCK_FAILURE_MODE=hang`
→ dispatch's per-chunk race kills the mock at 6s (`failed`), tier A serves,
`final.meta.fallbackTriggered: true`, decision log shows
`mock → failed · tier-a → served`.

---

## The failure map (everything, at a glance)

| stage | failure | status / code path | retried? |
|---|---|---|---|
| schema | bad body | 400 invalid_input | no |
| auth | missing/unknown key | 401 | no |
| auth | over quota | 429 + limits/used/reset | no |
| auth | can't verify quota | 503 quota_uncertain | no — fail closed |
| refusal | confidence < 0.48 | served refusal, cost 0, outcome `refused` | never (it's a decision, not an error) |
| dispatch | error / stall / empty stream on candidate | next candidate | yes, until first byte |
| dispatch | every candidate failed | 502 backend_unavailable + full plan | no |
| streaming | fault after first byte | explicit `error` SSE event, outcome `failed` | **never** (no mid-answer re-route) |
| output | unusable model answer | converted to refusal; request/token quota not charged, USD spend still recorded (the call happened) | caller retries |

The one design idea that ties it all together: **every decision before the
model is cheap and enforced; every failure after first byte is honest and
billed.** Routing and refusal happen on signals the gateway already had;
fallback happens on *output*, not on hope; and nothing that served you a broken
answer gets away with charging you for it.