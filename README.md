# Mini Inference Router

A miniature of a production LLM gateway: product teams call **one** API, the
gateway decides which model backend serves each request, enforces per-tenant
quotas, meters every call, and falls back automatically when a backend fails or
stalls. On top of it, one capability: a **customer support assistant** that
answers from a support knowledge base, returns a detected intent, and *refuses
to guess* at low confidence.

Built for the Mekari "Mini Inference Router" take-home. Design choices,
trade-offs, and declared scope cuts: [`docs/DECISIONS.md`](docs/DECISIONS.md)
(written before the code) and [`docs/REPORT.md`](docs/REPORT.md) (measured
numbers). Eval results: [`docs/EVALUATION.md`](docs/EVALUATION.md).

## What's in the box

```
gateway/   Fastify (TypeScript) — auth · quota · routing · fallback · metering · RAG capability
console/   React + Vite — chat playground with an X-ray panel + usage/decision-log view
eval/      30 held-out cases, A/B two-config comparison, LLM-judged groundedness
docs/      decision log, report, evaluation table, deploy runbook
```

## Architecture at a glance

```
tenants ── Bearer key ──► gateway (Fastify)
                            │ auth (sha256 key → tenant)
                            │ quota (daily requests+tokens, fails closed → 429)
                            │ rules: retrieval confidence + question complexity
                            ▼
                          plan: [tier-a, tier-b] (ROUTING_CHAIN can reorder for demos)
                            │ on error / stall → per-chunk timeout → next candidate
                            ▼
              backends: OpenRouter tier A (gemini-flash-lite) · tier B (claude-haiku) · mock
                            │
                            ▼
              metering → SQLite (requests, routing_decisions, quota_usage)
```

## Quickstart

```bash
npm install
cp gateway/.env.example gateway/.env     # add OPENROUTER_API_KEY + tier model IDs

npm run build:kb       # fetch the Bitext slice → 324 KB rows + 30 held-out eval cases
npm run dev            # gateway on :8787
cd console && npm run dev   # console on :5173 (proxies /v1)
```

Seed tenants (fixtures, override via `SEED_TENANTS`):

| tenant | API key (Bearer) | quota |
|---|---|---|
| `demo` | `sk_demo_key_0000000000000000` | 200 req/day |
| `stress` | `sk_stress_key_0000000000000000` | 3 req/day (to demo fail-closed quota) |

## API

`POST /v1/chat` — plain chat, SSE stream (`meta` → `delta…` → `final`).

`POST /v1/support-assistant` — grounded support answer, SSE stream, with the
retrieved entries, detected intent, and confidence in `meta`/`final`.
Optional `backendPin` (eval/debug only): pin a backend for A/B runs.

`GET /v1/usage` — per-tenant requests/cost/quota + routing decision log.

Failure behaviour: `401` unknown key · `429` quota exhausted (with usage
details) · `400` schema-validated input · `502 backend_unavailable` after every
candidate fails (nothing streams — fail closed) · mid-stream faults surface as
an `error` SSE event, never a silent half-answer. Confidence below the floor
(refusal) answers *without calling any model* and still gets metered.

## Reproducing the evaluation

```bash
npm run eval          # runs config A (tier A pinned) then B, writes docs/EVALUATION.md
```

Runs go **through** the gateway (real auth, quota, metering), not around it.

## Demoing fallback deterministically

```bash
ROUTING_CHAIN="mock,openrouter-tier-a" MOCK_FAILURE_MODE=fail npx tsx src/server.ts
# → decision log shows: mock → failed, openrouter-tier-a → served
MOCK_FAILURE_MODE=hang  # exercises the stall→timeout→fallback path
```

## Deploy

Self-hosted: systemd unit + NGINX (static console, `/v1/*` proxied to the
gateway) — runbook in [`docs/DEPLOY.md`](docs/DEPLOY.md).