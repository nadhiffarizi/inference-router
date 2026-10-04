# Mini Inference Router

A miniature of a production LLM gateway: product teams call **one** API, the
gateway decides which model backend serves each request, enforces what each
tenant is allowed, meters every call to the cent, and falls back automatically
when a backend fails or stalls. On top of it one capability: a **customer
support assistant** that answers from a support knowledge base, returns a
detected intent, and *refuses to guess* at low confidence.

Built for the Mekari "Mini Inference Router" take-home. Read in this order:

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — choices made **before** the code, with rejected alternatives
- [`docs/RULES.md`](docs/RULES.md) — the routing rules, their thresholds, and why each is defensible
- [`docs/FLOW.md`](docs/FLOW.md) — one request, end to end: gates, routing, fallback, settle-up
- [`docs/REPORT.md`](docs/REPORT.md) — measured numbers, trade-offs, and what was cut
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — the A/B eval table (30 held-out cases)
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — self-hosted deployment runbook

## What's in the box

```
gateway/   Fastify (TypeScript) — auth · quota · routing · fallback · metering · RAG capability
console/   React + Vite + shadcn-style UI — accounts, sessions, playground, activity/trace views
eval/      30 held-out cases run THROUGH the gateway; A/B comparison + LLM-judged groundedness
docs/      decision log · routing rules · report · evaluation · deploy runbook
```

## Architecture at a glance

```
console (session login)                product surface (per-tenant API key)
  ├─ Playground + sessions      ───┐
  ├─ API Keys (issue, named)       │        tenants ── curl/SDK ──► gateway (Fastify)
  ├─ Usage (own tenant)            │        POST /v1/chat             ├─ auth: sha256 key → tenant
  └─ Observability (admin)      ───┘        POST /v1/support-assistant ├─ quota: requests + USD budget/day
                                              (optional sessionId =      ├─ rules: confidence + complexity
                                               session grouping only)    │ per-chunk timeout → fallback
                                                                       └─ metering → SQLite (traces included)

                    backends: OpenRouter tier A (gemini-2.5-flash-lite) · tier B (claude-haiku-4.5)
                              + scripted mock (configurable latency/failure → deterministic fallback demos)
```

Two deliberately separate auth surfaces: **the console authenticates with a
session cookie** (accounts, no JWT — long-lived on purpose for this demo);
**product flows authenticate with the tenant's issued key**. Admin is a tenant
like any other; its role adds exactly one menu (Observability, cross-tenant,
server-enforced 403 for product users).

## Quickstart

```bash
npm install
cp gateway/.env.example gateway/.env      # add OPENROUTER_API_KEY + tier model IDs
npm run build:kb                          # Bitext slice → 324 KB rows + 30 held-out eval cases
npm run dev                               # gateway on :8787
cd console && npm run dev                 # console on :5173 (proxies /v1)
```

Seeded demo accounts (shared for this assessment, password `mekari-demo-2026`):

| account | role | tenant | quota |
|---|---|---|---|
| `team@demo.local` | product team | `demo` | 200 req · $0.70/day — **starts keyless**: issue it in the console |
| `admin@demo.local` | admin (is a tenant: `ops`) | `ops` | 500 req · $0.70/day + Observability |
| `zero@demo.local` | product team | `quota-zero` | 0 req/day — **every** request 429s on the first call (the instant quota demo) |
| — | eval fixture | `eval` | key `sk_eval_key_000000000000000000` (for `npm run eval`) |
| — | quota demo | `stress` | 3 req · $0.70/day — burns to a fail-closed 429 in ~4 calls |
| — | zero-quota fixture | `quota-zero` | key `sk_zero_key_0000000000000000` — 429 on request #1 |

## API

`POST /v1/chat` — plain chat, SSE stream (`meta` → `delta…` → `final`).
`POST /v1/support-assistant` — grounded support answer: answer + detected
intent + retrieved entries + confidence; refuses instead of guessing at low
confidence. Optional `sessionId` (string ≤100): **caller-declared session
grouping** — pass your own ticket/chat id; unseen ids are created on first
sight, unique per tenant. Grouping only: sessions never change model context.
Optional `backendPin` (eval/debug): pin a backend for A/B runs.
`Authorization: Bearer <key>` on both; responses stream as SSE.

Failure behaviour (all machine-readable `{error:{code,message,details}}`):
`401` unknown key/session · `400` schema-validated input with per-violation
details · `403` role/tenancy violations · `409` second key attempt (keys are
one-per-account and irreplaceable) · `429` quota exhausted (limits + usage +
reset in the body) · `502 backend_unavailable` after every candidate fails ·
mid-stream faults surface as an explicit `error` event, never a silent
half-answer. The refusal path is a designed outcome (`refused: true`, reason
included) and costs zero tokens because no model is called.

## Reproducing the evaluation

```bash
npm run eval   # A = tier A pinned, B = tier B pinned → docs/EVALUATION.md
```

Runs go **through** the gateway (real auth, quota, metering) via `backendPin`,
not around it.

## Demoing fallback deterministically

```bash
ROUTING_CHAIN="mock,openrouter-tier-a" MOCK_FAILURE_MODE=fail npx tsx src/server.ts
# decision log: mock → failed, openrouter-tier-a → served, fallbackTriggered: true
MOCK_FAILURE_MODE=hang   # exercises the stall → per-chunk router timeout → fallback path
```

## Deploy

Self-hosted: Docker (one container: gateway + console, host port 4000) behind
NGINX — runbook in [`docs/DEPLOY.md`](docs/DEPLOY.md); the nginx rule ships in
[`nginx/router.kreasiodigital.com.conf`](nginx/router.kreasiodigital.com.conf).
Live at **https://router.kreasiodigital.com**.