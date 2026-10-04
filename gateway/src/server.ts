import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { bootstrapDatabase, db, wasFreshDatabase } from "./db/index.js";
import { apiKeys, kbEntries, tenants, users } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerAssistantRoute } from "./routes/assistant.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { makeOpenRouterAdapter } from "./backends/openrouter.js";
import { makeMockAdapter } from "./backends/mock.js";
import { adapterRegistry } from "./routing/dispatch.js";
import type { AdapterMeta, ModelAdapter } from "./backends/types.js";
import { loadKb } from "./rag/kb.js";
import { errorBody, GatewayError } from "./lib/errors.js";
import { hashPassword, maskKey } from "./lib/password.js";

/**
 * Composition root. Boot order matters and is linear on purpose:
 * schema → fixture top-up (tenants/users) → adapters → KB index → routes → listen.
 * A missing env var or an unloadable KB fails here, loudly, at boot — the
 * same fail-closed posture applied at construction time.
 */

const SYSTEM_PROMPT =
  "You are a concise, helpful API assistant behind a multi-model gateway. Answer plainly.";

/**
 * Fixture tenants (D10) top up on EVERY boot, not just a fresh database: the
 * deployed box keeps its SQLite across restarts, so fixtures added to
 * SEED_TENANTS after first boot must still land there. Only MISSING names are
 * inserted — an existing tenant's row (its recorded usage, any env-overridden
 * limits) is never touched.
 */
async function seedFixtureTenants(): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.select({ name: tenants.name }).from(tenants);
  const known = new Set(existing.map((r) => r.name));
  for (const seed of config.seedTenants) {
    if (known.has(seed.name)) continue;
    const tenantId = await db
      .insert(tenants)
      .values({
        name: seed.name,
        requestsPerDay: seed.requestsPerDay ?? config.quota.requestsPerDay,
        tokensPerDay: config.quota.tokensPerDay,
        budgetUsdPerDay: seed.budgetUsdPerDay ?? config.quota.budgetUsdPerDay,
        createdAt: now,
      })
      .returning({ id: tenants.id })
      .then((r) => r[0]?.id);
    if (!tenantId) continue;
    if (seed.key === "-") continue; // keyless tenant → console issue flow is the real path
    await db.insert(apiKeys).values({
      tenantId,
      keyHash: createHash("sha256").update(seed.key).digest("hex"),
      keyPlain: seed.key,
      maskedKey: maskKey(seed.key),
      label: `default (${seed.name})`,
      createdAt: now,
    });
    console.log({ msg: `seeded fixture tenant "${seed.name}"` });
  }
}

async function seedFixtureUsers(): Promise<void> {
  // same top-up contract: fixture accounts land wherever the tenant exists,
  // never duplicated on an email that already has one
  const now = new Date().toISOString();
  const existing = await db.select({ email: users.email }).from(users);
  const known = new Set(existing.map((r) => r.email));
  for (const seed of config.seedUsers) {
    if (known.has(seed.email.toLowerCase())) continue;
    const tenant = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.name, seed.tenantName))
      .limit(1)
      .then((r) => r[0]);
    if (!tenant) {
      console.warn({ msg: `seed user skipped — tenant "${seed.tenantName}" not among seeded tenants`, email: seed.email });
      continue;
    }
    await db.insert(users).values({
      email: seed.email.toLowerCase(),
      passwordHash: hashPassword(seed.password),
      role: seed.role,
      tenantId: tenant.id,
      createdAt: now,
    });
    console.log({ msg: `seeded fixture user "${seed.email}"` });
  }
}

async function loadKbEntriesIfFresh(): Promise<void> {
  if (!wasFreshDatabase()) return;
  // KB rows come from data/kb.json, produced by `npm run build:kb`.
  try {
    const { readKbSeed } = await import("./rag/kb.js");
    const rows = readKbSeed();
    if (rows.length === 0) return;
    await db.insert(kbEntries).values(rows);
  } catch (err) {
    console.warn({ msg: "KB seed not loaded — the support assistant will refuse everything until 'npm run build:kb' runs and the DB is recreated", err: String(err) });
  }
}

function buildAdapters(): Map<string, ModelAdapter> {
  const a = config.backends.tierA;
  const b = config.backends.tierB;
  const m = config.backends.mock;
  const metaA: AdapterMeta = { id: a.id, label: a.label, modelId: a.model, tier: "a", timeoutMs: a.timeoutMs, pricePerMTokens: a.pricePerMTokens };
  const metaB: AdapterMeta = { id: b.id, label: b.label, modelId: b.model, tier: "b", timeoutMs: b.timeoutMs, pricePerMTokens: b.pricePerMTokens };
  const metaMock: AdapterMeta = { id: m.id, label: m.label, modelId: m.model, tier: "mock", timeoutMs: m.timeoutMs, pricePerMTokens: m.pricePerMTokens };
  return adapterRegistry([
    makeOpenRouterAdapter(metaA),
    makeOpenRouterAdapter(metaB),
    makeMockAdapter(metaMock),
  ]);
}

async function main(): Promise<void> {
  bootstrapDatabase();
  await seedFixtureTenants();
  await seedFixtureUsers();
  await loadKbEntriesIfFresh();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL?.trim() || "info" },
    trustProxy: true, // behind NGINX — req.protocol/ip come from the proxy
    genReqId: () => randomUUID(),
    bodyLimit: 1 * 1024 * 1024,
  });
  await app.register(cors, { origin: true });
  await app.register(cookie, {});

  // Single-process deploy (docker): serve the built console from this process
  // so one origin serves both the UI and the API. Explicit /v1 routes keep
  // precedence; unset env leaves behaviour identical to the dev setup.
  if (config.consoleDist) {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, { root: config.consoleDist });
    app.log.info({ dir: config.consoleDist }, "serving console dist");
    // Console uses real paths (/playground, /keys, …): anything that isn't a
    // static file and not an API call gets the SPA shell, so a refresh or a
    // shared deep link lands on the right menu.
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? "/";
      if (url.startsWith("/v1")) {
        reply.status(404).send(errorBody("not_found", `no route for ${req.method} ${url}`));
        return;
      }
      void reply.sendFile("index.html");
    });
  }

  const byId = buildAdapters();
  const kb = loadKb();
  app.log.info({ kb }, "knowledge base indexed");

  registerChatRoute(app, byId, SYSTEM_PROMPT);
  registerAssistantRoute(app, byId);
  registerConsoleRoutes(app);

  // Structured errors for every non-stream failure path (auth, quota, JSON
  // validation): machine-readable {error:{code,message,...}} per DECISIONS.
  app.setErrorHandler<FastifyError>((err, _req, reply) => {
    if (err instanceof GatewayError) {
      reply.status(err.status).send(errorBody(err.code, err.message, err.details));
      return;
    }
    type ValidationErr = FastifyError & { validation?: unknown[] };
    if ((err as ValidationErr).validation) {
      // Fastify schema violations → 400 invalid_input with details.
      reply.status(400).send(errorBody("invalid_input", err.message ?? "invalid request body", { violations: (err as ValidationErr).validation }));
      return;
    }
    app.log.error({ err }, "unhandled error");
    reply.status(500).send(errorBody("internal", "internal error — see gateway logs"));
  });

  app.get("/v1/health", async () => ({ status: "ok" }));

  const port = config.port;
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info({ port, backends: [...byId.keys()] }, "gateway listening");
}

main().catch((err) => {
  console.error("gateway failed to boot:", err);
  process.exit(1);
});

// Unused-import guard: FastifyInstance type is re-exported for route modules.
export type { FastifyInstance };