import { desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { apiKeys, requests, routingDecisions, tenants } from "../db/schema.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { readUsage, utcDay } from "../lib/quota.js";
import { authenticateUser, generateApiKey } from "../lib/password.js";
import {
  clearSessionCookie, consoleAuth, createSession, destroySession, setSessionCookie,
  type ConsoleUser,
} from "../lib/session.js";

/**
 * Console surface — session-authenticated (30-day cookie). The product flows
 * (/v1/chat, /v1/support-assistant) are NOT here: they keep API-key auth.
 * Role model: admin is a tenant like any other; its role adds exactly one
 * menu (Observability = cross-tenant reads), enforced server-side here.
 */

const LoginSchema = {
  type: "object",
  required: ["email", "password"],
  properties: { email: { type: "string", maxLength: 120 }, password: { type: "string", minLength: 1, maxLength: 200 } },
  additionalProperties: false,
} as const;

const IssueKeySchema = {
  type: "object",
  properties: { label: { type: "string", maxLength: 80 } },
  additionalProperties: false,
} as const;

type ConsoleRequest = FastifyRequest & { consoleUser: ConsoleUser };

/** Own-tenant usage summary — the product team's slice of observability. */
async function tenantUsage(tenantId: number) {
  const day = utcDay();
  const usage = await readUsage(tenantId);

  const totals = await db
    .select({ costUsd: requests.estimatedCostUsd })
    .from(requests)
    .where(eq(requests.tenantId, tenantId))
    .then((rows) => ({ requests: rows.length, costUsd: rows.reduce((s, r) => s + r.costUsd, 0) }));

  const tenant = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1).then((r) => r[0]);
  if (!tenant) throw errors.internal("tenant row vanished");

  const decisions = await db
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.tenantId, tenantId))
    .orderBy(desc(routingDecisions.id))
    .limit(15)
    .then((rows) => rows.map(plainDecision));

  return {
    tenant: { id: tenant.id, name: tenant.name },
    today: { requests: usage.requestCount, tokens: usage.tokensTotal, costsUsd: usage.usdSpend, day },
    quota: {
      requestsPerDay: tenant.requestsPerDay,
      tokensPerDay: tenant.tokensPerDay,
      budgetUsdPerDay: tenant.budgetUsdPerDay,
    },
    remaining: {
      requests: Math.max(0, tenant.requestsPerDay - usage.requestCount),
      tokens: Math.max(0, tenant.tokensPerDay - usage.tokensTotal),
      budgetUsd: Math.max(0, Number((tenant.budgetUsdPerDay - usage.usdSpend).toFixed(4))),
    },
    totals,
    decisions,
  };
}


function plainDecision(r: typeof routingDecisions.$inferSelect) {
  return {
    requestId: r.requestId,
    capability: r.capability,
    plan: JSON.parse(r.planJson) as { backendId: string; action: string; reason: string }[],
    chosenBackendId: r.chosenBackendId,
    fallbackTriggered: r.fallbackTriggered,
    createdAt: r.createdAt,
  };
}

export function registerConsoleRoutes(app: FastifyInstance): void {
  app.post<{ Body: { email: string; password: string } }>(
    "/v1/console/login",
    { schema: { body: LoginSchema } },
    async (req, reply) => {
      const user = await authenticateUser(req.body.email, req.body.password);
      if (!user) throw errors.unauthorized("Invalid email or password.");
      const token = await createSession(user.id);
      setSessionCookie(reply, token);
      return { user: { email: user.email, role: user.role, tenantId: user.tenantId } };
    },
  );

  app.post("/v1/console/logout", async (req, reply) => {
    const token = (req.cookies as Record<string, string | undefined>)?.[config.sessionCookie.name];
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/v1/console/me", { onRequest: consoleRoute }, async (req) => {
    const user = (req as unknown as ConsoleRequest).consoleUser;
    return { user: { email: user!.email, role: user!.role, tenant: user!.tenant }, usage: user!.usage };
  });

  app.get("/v1/console/keys", { onRequest: consoleRoute }, async (req) => {
    const user = reqUser(req);
    const rows = await db
      .select({ id: apiKeys.id, maskedKey: apiKeys.maskedKey, label: apiKeys.label, createdAt: apiKeys.createdAt })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, user.tenant.id))
      .orderBy(desc(apiKeys.id));
    return { keys: rows, endpoints: endpointList(req) };
  });

  app.post<{ Body: { label?: string } }>("/v1/console/keys", { onRequest: consoleRoute }, async (req, reply) => {
    const user = reqUser(req);
    const { key, keyHash, masked } = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: user.tenant.id,
      keyHash,
      maskedKey: masked,
      label: req.body.label?.trim() || `issued ${new Date().toISOString().slice(0, 10)}`,
      createdAt: new Date().toISOString(),
    });
    reply.status(201);
    // Plaintext returned exactly once; nothing else in the system can show it again.
    return { apiKey: key, maskedKey: masked, endpoints: endpointList(req) };
  });

  /** Product team's own usage slice. */
  app.get("/v1/console/usage", { onRequest: consoleRoute }, async (req) => {
    return tenantUsage(reqUser(req).tenant.id);
  });

  /** Admin-only: cross-tenant usage + the routing decision log. */
  app.get("/v1/console/observability", { onRequest: consoleRoute }, async (req) => {
    if (reqUser(req).role !== "admin") throw errors.forbidden("Observability is admin-only.");
    const all = await db.select().from(tenants).orderBy(tenants.id);
    const tenantsSummary: Awaited<ReturnType<typeof tenantUsage>>[] = [];
    for (const t of all) {
      try {
        tenantsSummary.push(await tenantUsage(t.id));
      } catch (err) {
        // A broken tenant row must not blank the ops view.
        console.error({ msg: "tenant usage failed", tenantId: t.id, err: String(err) });
      }
    }
    const decisions = await db
      .select()
      .from(routingDecisions)
      .orderBy(desc(routingDecisions.id))
      .limit(25)
      .then((rows) => rows.map(plainDecision));
    return { tenants: tenantsSummary, decisions };
  });
}

/** PreHandler that resolves the session and attaches the console user. */
const consoleRoute = async (req: FastifyRequest): Promise<void> => {
  const user: ConsoleUser = await consoleAuth(req);
  Object.assign(req, { consoleUser: user });
};

function reqUser(req: FastifyRequest): ConsoleUser {
  const u = (req as unknown as ConsoleRequest).consoleUser;
  if (!u) throw errors.unauthorized("not authenticated");
  return u;
}

/** Endpoint list for the API-keys screen: absolute URLs from the incoming request. */
function endpointList(req: FastifyRequest): { path: string; url: string; description: string }[] {
  const base = `${req.protocol}://${req.headers.host ?? "localhost"}`;
  return [
    { path: "/v1/chat", url: `${base}/v1/chat`, description: "plain chat, SSE stream" },
    { path: "/v1/support-assistant", url: `${base}/v1/support-assistant`, description: "grounded support answer with intent + confidence, SSE" },
  ];
}
