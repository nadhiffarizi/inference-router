# Decision Log — Mini Inference Router

Written **before** the code, on purpose: every choice below is one the assessment
asks to defend ("rules you can defend", "judgement: what you built, what you
skipped, and whether you said so"). Each entry states the decision, the reason,
and what was rejected.

---

## Context

Take-home for Mekari (AI Builder role). Build a mini LLM inference router:

- **Gateway**: chat endpoint with streaming, per-tenant API-key auth,
  per-tenant quota failing closed, metering (model / tokens / latency /
  estimated cost / outcome) persisted to a database.
- **Routing**: ≥2 model backends with defensible selection rules; fallback on
  failure or slowness, with the decision recorded and inspectable.
- **One capability on top**: support assistant over the Bitext customer-support
  dataset — answer + detected intent + retrieved entries + confidence, refusing
  rather than guessing at low confidence.
- **Console**: chat playground exposing the internals; usage view per tenant.
- **Eval**: ~30 held-out cases, two configurations compared. One day of work.
  Deployed URL required. Brief supplies no LLM API keys.

The full brief is at `assessment_extracted.txt` in the repo root.

## Prior art I'm drawing from

I currently operate a small production app (IELTS prep SaaS) whose AI calls run
through OpenRouter (`src/lib/ai.ts` in that repo). Three lessons transfer here:

1. A hardcoded upstream **timeout with `AbortController`** is non-negotiable —
   a stalled model call once outlived our front proxy's budget and killed
   background jobs with 524s. This is exactly the assessment's "too slow →
   fallback" requirement, learned the hard way.
2. **A failed/partial model output must never consume user quota** — the same
   fail-closed philosophy the assessment demands for tenant quota.
3. Client code that resolves config through a **setting → env → default**
   ladder is operationally cheap; the assessment replaces the human knob with
   automatic per-request rules.

---

## D1 — One system, not microservice sprawl

One repo. The gateway is the product; the support assistant is a *layer inside*
it (a "task capability" behind the same auth/quota/metering path), and the
console is a thin client. The eval is a separate script, not a service.

## D2 — Node.js + TypeScript; Fastify for the gateway

The brief says "back end Node js". Within Node I picked Fastify over Express/
Hono/Nest/bare http because built-in JSON-schema validation (Ajv) directly
serves two assessed criteria (**invalid input**, **failure behaviour**) — a 400/
429 with a machine-readable body falls out of the framework. Pino structured
logging is in the box. SSE is trivial over `reply.raw`.

Rejected: Go would be the production choice for SSE-stream density (and worth
saying so in the report), but the brief mandates Node, and at this scale the
interesting problems — routing rules, failure semantics, metering accuracy —
are language-independent. NestJS: too much boilerplate for ~6 routes in a day.

## D3 — Console: static React (Vite), gateway separate

`console/` is a Vite React app — static files once built; NGINX serves them and
only proxies `/v1/*` to the Fastify process. Two audiences, **no RBAC**:

- Tenants authenticate with gateway-issued keys → raw HTTP/SSE API
  (`POST /v1/chat`, `POST /v1/support-assistant`). No UI exists on the tenant path.
- The console (playground + usage) is an internal/demo surface; the tenant key
  it uses is chosen there, and it renders the response *metadata* the gateway
  emits (model, fallback, retrieval, intent, tokens, latency, cost).

Cut: no login system for the console. The assessed permission boundary is
tenant isolation at the API layer (key → tenant identity → quota), which is
where it actually belongs.

## D4 — Backends: one adapter interface, OpenRouter as the provider, 3 backends

A `ModelAdapter` interface so any OpenAI-compatible endpoint works; OpenRouter
(one held key, server-side env) serves **two real backends**, differing by tier:

- **backend-a** — fast/cheap tier: default for known, low-complexity requests.
- **backend-b** — capable tier: default when retrieval is weak or the question
  looks ambiguous.

Concrete model IDs are pinned at build time by querying OpenRouter's `/models`
(never guessed), and are the "two configurations" the eval compares.

Plus **backend-mock** — scripted backend with configurable latency/failure rate,
exactly what the brief suggests, so fallback deterministically fires during the
video demo.

## D5 — Routing: per-request rules, every decision written down

Rules (evaluated in order, first match wins), inputs are just three cheap
signals the gateway already has:

1. Refusal path: retrieval confidence below floor → no model is called at all.
2. Weak retrieval confidence or long/ambiguous question → backend-b (capable).
3. Otherwise → backend-a (fast/cheap).

Then always: on backend error, or when it hasn't produced first output (or
completion) within its timeout budget → **fallback to the next backend**, with
the decision recorded and inspectable.

Every request writes a `routing_decisions` row: candidates tried, why each was
chosen/skipped/abandoned (error? timeout? policy), which served. The console's
routing log renders this. The timeout threshold is inherited from experience
(sit behind a proxy that caps request time — never hang past it).

## D6 — Storage: SQLite via Drizzle ORM

Single-box deployment, two-seed tenants, zero infra. Tables: `tenants`,
`api_keys`, `requests` (metering), `routing_decisions`, `quota_usage`,
`kb_entries`, `settings`. Trade-off recorded in the report: SQLite is not the
production shape for a multi-tenant gateway, and swapping the Drizzle driver
for Postgres is a config change, not a rewrite.

## D7 — Retrieval: in-process lexical (MiniSearch), not embeddings

Earlier plan used a provider's embedding endpoint. Revision: all real backends
go through OpenRouter, which exposes **no embeddings API**, and pulling in a
local embedding model (transformers.js/ONNX) is disproportionate to one day of
work. So: the Bitext slice is indexed in-process with lexical scoring
(MiniSearch BM25-style, fuzzy matching, field boosts). Questions and answers in
the dataset share enough vocabulary with the held-out questions that lexical
retrieval is adequate for a 27-intent KB; the confidence signal becomes the
normalized top hit score.

Cut (and stated): vector retrieval, cross-encoder reranking.

## D8 — Eval: 30 held-out cases, exact-match intent, layered answer quality

- Intent accuracy: exact match against the dataset's intent labels (the model
  picks from a constrained enum of the 27 intents).
- Answer quality, two layers: deterministic groundedness checks (does the
  answer draw on retrieved entries; no invented URLs/codes) + LLM-as-judge
  scoring 1–5 against the retrieved context.
- The same 30 cases run against both tiers (**config A** fast/cheap vs
  **config B** capable) → one comparison table: accuracy, quality, latency, cost.

## D9 — Deploy: self-hosted box behind NGINX + Cloudflare DNS

Deploy target is this box (not Vercel/Render): a systemd-managed gateway
process + NGINX serving the built console and proxying `/v1/*`; TLS via a
Cloudflare-mapped subdomain. This deploys in minutes and needs no cold-start
budget — a streaming demo stays reliable.

## D10 — Scope cuts (declared up front)

Cut deliberately rather than half-build:

- No conversation history / multi-turn memory (single-turn assistant).
- No tenant CRUD UI — tenants and keys are seeded fixtures.
- Quota = simple per-day request/token counters (fixed window), not sliding.
- Lexical retrieval only (no vectors).
- SSE only (no WebSocket).
- No retries beyond the single fallback hop.
- No console auth (internal surface); tenant auth is the assessed boundary.
- No cost-calibration wizard: provider prices are config constants.
---

## Addendum — decisions made while building (2026-10-04)

The sections below were decided during development, after D10 was written.
Where they supersede earlier cuts, the supersession is stated — the honest
version of "scope grew on purpose", and the reason each addition still serves
the brief's core requirements rather than decorating them.

### D11 — Console accounts: admin IS a tenant; session cookie, no JWT

The console gained accounts (`users` + `sessions`, scrypt-hashed passwords,
opaque 30-day cookie) so tenancy is *demonstrated in UI* instead of asserted
in prose. The product-team account experiences exactly what a customer gets:
keyless start → issue key → integrate. The admin account is **a tenant like
any other** — identical Playground / API Keys / Usage flows — plus one extra
menu, **Observability** (cross-tenant reads + decision log), enforced
server-side (403 for product users, not hidden by CSS).

This supersedes D3's "no login system" and D10's "no tenant CRUD UI" — the
substitution: full RBAC (users × roles × permission UI) stayed cut; what was
built is identity + one role bit, the minimum that makes *one key = one
tenant identity* visible. Product flows keep API-key auth; sessions never
leak into the request path.

### D12 — One account, one key; irreplaceable; named

Issuance only when the account has no key (409 otherwise). Rotation was
removed by explicit simplification — a key is a permanent identity artifact
for this demo, not a rotating credential (fixtures reset via a fresh database).
Keys are **named at issuance** (dialog, required) and tracked by name —
OpenRouter's model: usage and observability aggregate **per key name**, and
metering rows carry the key's denormalized label so history survives any key
lifecycle. Product/admin tenants seed *keyless* so the console issue flow is
the real path; the `eval` tenant keeps a fixture key for the A/B harness.

### D13 — Quota currency is USD

Two counters fail closed: requests/day and a **USD spend budget/day**
computed from the same metering rows the cost column records. No credits
layer: a credit system needs a conversion rate for zero product value, and it
would blur the brief's "cost recorded accurately" criterion. The earlier
tokens/day ceiling stays as an abuse backstop.

### D14 — Activity feed + trace viewer ("Langfuse-mini")

OpenRouter's *activity* pattern for the gateway calls: one row per request
(time, tenant, key name, model, outcome, tokens, cost, latency → clickable).
A stored **turn trace** rides on the metering row (`question`, `answer`,
`retrieval_json`), so every call is *replayable*, not just countable. The
viewer dialog shows the turn end to end: question bubble → answer (or refusal
reason) → retrieved entries + confidence → routing plan → metering. Own
implementation on our design system; Langfuse is a conceptual reference only.

### D15 — Chat sessions: grouping, never memory

Optional caller-declared `sessionId` on the product endpoints (≤100 chars).
Grouping on first sight: an unseen id creates the session (title = first
question); later turns join by `(tenant_id, external_id)` uniqueness —
another tenant's identical id can never attach. The playground generates its
own uuids; a product team passes their ticket id — **same mechanism**, no
gateway-side session issuance. Deletion is soft (`deleted_at`): hidden from
the tenant surface, retained for observability.

Boundary kept deliberately: sessions are **trace grouping, not model
context**. The assistant stays single-turn (D10's cut stands for memory) —
the eval measures single-turn quality and the gateway does not become a party
to tenant conversation state. The defense: this is exactly Langfuse's model —
sessions explain *who was talking to whom*, prompts describe *what the model
received*.
