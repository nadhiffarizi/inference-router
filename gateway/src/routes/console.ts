import { and, desc, eq, gte, inArray, isNotNull, isNull, like, or, sql, type SQLWrapper } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { apiKeys, chatSessions, requests, routingDecisions, tenants } from "../db/schema.js";
import { config } from "../config.js";
import { errorBody, errors } from "../lib/errors.js";
import { readUsage, utcDay } from "../lib/quota.js";
import { authenticateUser, generateApiKey } from "../lib/password.js";
import { listSessions, sessionTurns, softDeleteSession } from "../lib/chatSessions.js";
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


/** Per-KEY usage (openrouter-style): requests + spend grouped by key name. */
async function keyUsage(tenantId: number) {
  const day = utcDay();
  const rows = await db
    .select({
      label: requests.keyLabel,
      apiKeyId: requests.apiKeyId,
      requests: sql<number>`count(*)`,
      tokens: sql<number>`coalesce(sum(${requests.promptTokens} + ${requests.completionTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${requests.estimatedCostUsd}), 0)`,
    })
    .from(requests)
    .where(and(eq(requests.tenantId, tenantId), sql`substr(${requests.createdAt}, 1, 10) = ${day}`))
    .groupBy(requests.apiKeyId);

  // Attach still-listed labels from the keys table (deleted/renamed rows keep their metered label).
  const named = await db
    .select({ id: apiKeys.id, label: apiKeys.label, maskedKey: apiKeys.maskedKey, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(desc(apiKeys.id));
  const byMeteredLabel = new Map(rows.map((r) => [r.label ?? "unknown", r]));

  const out: {
    label: string; maskedKey: string | null; requests: number; tokens: number; costUsd: number; active: boolean;
  }[] = [];
  for (const k of named) {
    const metered = byMeteredLabel.get(k.label);
    out.push({
      label: k.label,
      maskedKey: k.maskedKey,
      requests: metered?.requests ?? 0,
      tokens: metered?.tokens ?? 0,
      costUsd: metered?.costUsd ?? 0,
      active: true,
    });
    if (metered) byMeteredLabel.delete(k.label);
  }
  for (const [label, m] of byMeteredLabel) {
    out.push({ label: label ?? "unknown", maskedKey: null, requests: m.requests, tokens: m.tokens, costUsd: m.costUsd, active: false });
  }
  return out;
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

/** Nearest-rank percentile of a column, ascending — the value `q` of samples
    land under. Empty inputs read as 0, which a chart never draws from anyway. */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]!;
}

/** ---- admin log explorer: the see-all pages behind the top-K tables ----
    Same rows the summary surfaces render (top-K), read here with paging,
    search and filters so the ops pages can leave the K behind. */

type PageParams = { q: string | undefined; limit: number; offset: number; tenant: string | undefined };

function pageParams(req: FastifyRequest): PageParams {
  const p = req.query as Record<string, string | undefined>;
  return {
    /** LIKE pattern — SQLite LIKE is case-insensitive for ASCII, which is
        what the seeded ids/labels/questions are made of. */
    q: (p.q ?? "").trim().slice(0, 120) || undefined,
    limit: Math.min(200, Math.max(1, Number(p.limit) || 25)),
    offset: Math.max(0, Number(p.offset) || 0),
    tenant: p.tenant?.trim() || undefined,
  };
}

/**
 * Day-range filter (the observability pages' date pickers): `from`/`to` as
 * YYYY-MM-DD in UTC — timestamps are stored as UTC ISO text, so the inclusive
 * day range is two string-slice comparisons, no parsing. A malformed value is
 * ignored rather than 400ing — a query param is a view preference, not data
 * the caller depends on.
 */
function dayRangeParams(p: { from?: string; to?: string }): { from: string | undefined; to: string | undefined } {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const from = DATE.test(p.from?.trim() ?? "") ? p.from!.trim() : undefined;
  const to = DATE.test(p.to?.trim() ?? "") ? p.to!.trim() : undefined;
  if (from && to && from > to) return { from: to, to: from }; // swapped pickers read as intended, not as empty
  return { from, to };
}

function dayRangeConditions(col: AnySQLiteColumn, range: { from: string | undefined; to: string | undefined }): SQLWrapper[] {
  const day = sql<string>`substr(${col}, 1, 10)`;
  if (range.from && range.to) return [sql`${day} >= ${range.from}`, sql`${day} <= ${range.to}`];
  if (range.from) return [sql`${day} >= ${range.from}`];
  if (range.to) return [sql`${day} <= ${range.to}`];
  return [];
}

/** The console surfaces tenant *names*; the tables key on ids. */
async function tenantIdFilter(tenant?: string): Promise<{ ids: number[]; names: string[] }> {
  const all = await db.select({ id: tenants.id, name: tenants.name }).from(tenants).orderBy(tenants.id);
  return {
    ids: (tenant ? all.filter((t) => t.name === tenant) : all).map((t) => t.id),
    names: all.map((t) => t.name),
  };
}

function adminOnly(req: FastifyRequest): ConsoleUser {
  const user = reqUser(req);
  if (user.role !== "admin") throw errors.forbidden("Observability is admin-only.");
  return user;
}

type PlanStepJson = { backendId: string; action: string; reason: string };

/** Shared row shape for the activity list — the summary feed's rows plus the
    routing plan, so a see-all row opens the same trace viewer on its own. */
function activityRow(
  r: typeof requests.$inferSelect,
  decision: { planJson: string | null; fallbackTriggered: boolean | null } | undefined,
  tenantName: string,
) {
  return {
    id: r.id,
    createdAt: r.createdAt,
    tenant: tenantName,
    capability: r.capability,
    keyLabel: r.keyLabel,
    backendId: r.backendId,
    modelId: r.modelId,
    tokens: r.promptTokens + r.completionTokens,
    costUsd: r.estimatedCostUsd,
    latencyMs: r.latencyMs,
    ttftMs: r.ttftMs,
    outcome: r.outcome,
    question: r.question,
    answer: r.answer,
    retrievalConfidence: r.confidence,
    retrieval: r.retrievalJson
      ? (JSON.parse(r.retrievalJson) as { id: number; question: string; answer: string; intent: string }[])
      : null,
    intent: r.intent,
    error: r.error,
    plan: decision?.planJson ? (JSON.parse(decision.planJson) as PlanStepJson[]) : [],
    fallbackTriggered: decision?.fallbackTriggered ?? false,
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
      .select({ id: apiKeys.id, maskedKey: apiKeys.maskedKey, label: apiKeys.label, createdAt: apiKeys.createdAt, key: apiKeys.keyPlain })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, user.tenant.id))
      .orderBy(desc(apiKeys.id));
    return { keys: rows, endpoints: endpointList(req) };
  });

  /**
   * One account, one key — and it's irreplaceable for this demo: issuance
   * only when none exists (the seeded fixture key counts). This makes the
   * key a permanent identity artifact rather than a rotating credential —
   * fine at demo scale, and a fresh `gateway.sqlite` restores the seed key.
   */
  app.post<{ Body: { label?: string } }>("/v1/console/keys", { onRequest: consoleRoute }, async (req, reply) => {
    const user = reqUser(req);
    const existing = await db
      .select({ id: apiKeys.id, label: apiKeys.label })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, user.tenant.id))
      .limit(1)
      .then((r) => r[0]);
    if (existing) {
      throw errors.conflict(
        `Key already exists (${existing.label}) and is irreplaceable — recreate the database to reset demo fixtures.`,
      );
    }
    const { key, keyHash, masked } = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: user.tenant.id,
      keyHash,
      keyPlain: key,
      maskedKey: masked,
      label: req.body.label?.trim() || `key ${new Date().toISOString().slice(0, 10)}`,
      createdAt: new Date().toISOString(),
    });
    reply.status(201);
    return { apiKey: key, maskedKey: masked, endpoints: endpointList(req) };
  });

  /** Product team's own usage slice. */
  app.get("/v1/console/usage", { onRequest: consoleRoute }, async (req) => {
    const tenantId = reqUser(req).tenant.id;
    const summary = await tenantUsage(tenantId);
    return { ...summary, keyUsage: await keyUsage(tenantId) };
  });

  /** Chat sessions (Langfuse-style grouping) — own tenant. */
  app.get("/v1/console/chat-sessions", { onRequest: consoleRoute }, async (req) => {
    return { sessions: await listSessions(reqUser(req).tenant.id, { includeDeleted: true }) };
  });

  app.delete<{ Params: { uid: number } }>("/v1/console/chat-sessions/:uid", { onRequest: consoleRoute }, async (req, reply) => {
    const ok = await softDeleteSession(reqUser(req).tenant.id, Number(req.params.uid));
    reply.status(ok ? 200 : 404);
    return ok ? { ok: true } : errorBody("not_found", "session not found");
  });

  /** Session timeline: the session's turns with full traces (own tenant). */
  app.get<{ Params: { uid: number } }>("/v1/console/chat-sessions/:uid", { onRequest: consoleRoute }, async (req) => {
    const turns = await sessionTurns(Number(req.params.uid), reqUser(req).tenant.id);
    if (!turns) throw errors.forbidden("no such session for this tenant");
    return turns;
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

    // Per-key usage across ALL tenants (openrouter-style: track by name, not key string).
    const fleetKeys: Awaited<ReturnType<typeof keyUsage>> = [];
    for (const t of all) {
      try {
        fleetKeys.push(...(await keyUsage(t.id)).map((k) => ({ ...k, tenant: t.name })));
      } catch {
        /* skip broken tenant */
      }
    }

    // Activity feed: the individual gateway calls (latest 50) with traces —
    // openrouter's "activity" table. Clicking one opens the chat-turn viewer.
    const tenantNameById = new Map(all.map((t) => [t.id, t.name]));
    const activity = await db
      .select()
      .from(requests)
      .orderBy(desc(requests.createdAt))
      .limit(50)
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          tenant: tenantNameById.get(r.tenantId) ?? String(r.tenantId),
          capability: r.capability,
          keyLabel: r.keyLabel,
          backendId: r.backendId,
          modelId: r.modelId,
          tokens: r.promptTokens + r.completionTokens,
          costUsd: r.estimatedCostUsd,
          latencyMs: r.latencyMs,
          ttftMs: r.ttftMs,
          outcome: r.outcome,
          // trace payload for the chat-turn viewer:
          question: r.question,
          answer: r.answer,
          retrievalConfidence: r.confidence,
          retrieval: r.retrievalJson ? (JSON.parse(r.retrievalJson) as { id: number; question: string; answer: string; intent: string }[]) : null,
          intent: r.intent,
          error: r.error,
        })),
      );

    // All sessions across tenants (deleted included — an ops surface shows history).
    const allSessions = await db
      .select({
        uid: chatSessions.uid,
        tenantName: tenants.name,
        externalId: chatSessions.externalId,
        title: chatSessions.title,
        createdAt: chatSessions.createdAt,
        updatedAt: chatSessions.updatedAt,
        deletedAt: chatSessions.deletedAt,
        turns: sql<number>`(SELECT count(*) FROM requests WHERE requests.chat_session_uid = ${chatSessions.uid})`,
        spendUsd: sql<number>`(SELECT coalesce(sum(estimated_cost_usd), 0) FROM requests WHERE requests.chat_session_uid = ${chatSessions.uid})`,
      })
      .from(chatSessions)
      .innerJoin(tenants, eq(tenants.id, chatSessions.tenantId))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(100);

    return { tenants: tenantsSummary, keys: fleetKeys, activity, sessions: allSessions, decisions };
  });

  /** Admin: any session's timeline (cross-tenant). */
  app.get<{ Params: { uid: number } }>("/v1/console/observability/sessions/:uid", { onRequest: consoleRoute }, async (req) => {
    if (reqUser(req).role !== "admin") throw errors.forbidden("Observability is admin-only.");
    return sessionTurns(Number(req.params.uid)); // cross-tenant: role already verified
  });

  /** ---- see-all pages: paginated, searchable, filterable reads ---- */

  app.get("/v1/console/observability/activity", { onRequest: consoleRoute }, async (req) => {
    adminOnly(req);
    const p = req.query as Record<string, string | undefined>;
    const { q, limit, offset, tenant } = pageParams(req);
    const outcome = p.outcome?.trim() || undefined;
    const capability = p.capability?.trim() || undefined;
    const { ids, names } = await tenantIdFilter(tenant);
    const conditions = [
      inArray(requests.tenantId, ids.length ? ids : [-1]),
      // the keys endpoint's "today" filter is deliberately absent here: the
      // activity page takes a caller-picked day range instead
      ...dayRangeConditions(requests.createdAt, dayRangeParams(p)),
    ];
    if (q) {
      conditions.push(
        or(
          like(requests.question, `%${q}%`),
          like(requests.id, `%${q}%`),
          like(requests.modelId, `%${q}%`),
          like(requests.keyLabel, `%${q}%`),
        )!,
      );
    }
    if (outcome) conditions.push(eq(requests.outcome, outcome));
    if (capability) conditions.push(eq(requests.capability, capability));
    if (q) {
      conditions.push(
        or(
          like(requests.question, `%${q}%`),
          like(requests.id, `%${q}%`),
          like(requests.modelId, `%${q}%`),
          like(requests.keyLabel, `%${q}%`),
        )!,
      );
    }
    const where = and(...conditions);

    const total = await db
      .select({ n: sql<number>`count(*)` })
      .from(requests)
      .where(where)
      .then((r) => r[0]?.n ?? 0);

    const rows = await db
      .select({
        r: requests,
        planJson: routingDecisions.planJson,
        fallbackTriggered: routingDecisions.fallbackTriggered,
        tenant: tenants.name,
      })
      .from(requests)
      .innerJoin(tenants, eq(tenants.id, requests.tenantId))
      .leftJoin(routingDecisions, eq(routingDecisions.requestId, requests.id))
      .where(where)
      .orderBy(desc(requests.createdAt))
      .limit(limit)
      .offset(offset)
      .then((rows) => rows.map((row) => activityRow(row.r, row, row.tenant)));

    return {
      rows, total, limit, offset,
      facets: { tenants: names, outcomes: ["ok", "failed", "refused"], capabilities: ["chat", "support-assistant"] },
    };
  });

  app.get("/v1/console/observability/sessions", { onRequest: consoleRoute }, async (req) => {
    adminOnly(req);
    const p = req.query as Record<string, string | undefined>;
    const { q, limit, offset, tenant } = pageParams(req);
    const { ids, names } = await tenantIdFilter(tenant);
    const state = p.state === "active" || p.state === "deleted" ? p.state : undefined;
    const conditions = [
      inArray(chatSessions.tenantId, ids.length ? ids : [-1]),
      // range on creation time — the same field the sessions chart buckets
      ...dayRangeConditions(chatSessions.createdAt, dayRangeParams(p)),
    ];
    if (q) conditions.push(or(like(chatSessions.title, `%${q}%`), like(chatSessions.externalId, `%${q}%`))!);
    if (state === "active") conditions.push(isNull(chatSessions.deletedAt));
    if (state === "deleted") conditions.push(isNotNull(chatSessions.deletedAt));
    const where = and(...conditions);

    const total = await db
      .select({ n: sql<number>`count(*)` })
      .from(chatSessions)
      .where(where)
      .then((r) => r[0]?.n ?? 0);

    const rows = await db
      .select({
        uid: chatSessions.uid,
        tenantName: tenants.name,
        externalId: chatSessions.externalId,
        title: chatSessions.title,
        createdAt: chatSessions.createdAt,
        updatedAt: chatSessions.updatedAt,
        deletedAt: chatSessions.deletedAt,
        turns: sql<number>`(SELECT count(*) FROM requests WHERE requests.chat_session_uid = ${chatSessions.uid})`,
        spendUsd: sql<number>`(SELECT coalesce(sum(estimated_cost_usd), 0) FROM requests WHERE requests.chat_session_uid = ${chatSessions.uid})`,
      })
      .from(chatSessions)
      .innerJoin(tenants, eq(tenants.id, chatSessions.tenantId))
      .where(where)
      .orderBy(desc(chatSessions.updatedAt))
      .limit(limit)
      .offset(offset);

    return { rows, total, limit, offset, facets: { tenants: names, state: ["active", "deleted"] } };
  });

  app.get("/v1/console/observability/decisions", { onRequest: consoleRoute }, async (req) => {
    adminOnly(req);
    const p = req.query as Record<string, string | undefined>;
    const { q, limit, offset, tenant } = pageParams(req);
    const { ids, names } = await tenantIdFilter(tenant);
    const capability = p.capability?.trim() || undefined;
    const conditions = [inArray(routingDecisions.tenantId, ids.length ? ids : [-1]), ...dayRangeConditions(routingDecisions.createdAt, dayRangeParams(p))];
    if (q) conditions.push(or(like(routingDecisions.requestId, `%${q}%`), like(routingDecisions.chosenBackendId, `%${q}%`))!);
    if (capability) conditions.push(eq(routingDecisions.capability, capability));
    if (p.fallback === "fired") conditions.push(eq(routingDecisions.fallbackTriggered, true));
    if (p.fallback === "quiet") conditions.push(eq(routingDecisions.fallbackTriggered, false));
    const where = and(...conditions);

    const total = await db
      .select({ n: sql<number>`count(*)` })
      .from(routingDecisions)
      .where(where)
      .then((r) => r[0]?.n ?? 0);

    const rows = await db
      .select({ d: routingDecisions, tenant: tenants.name })
      .from(routingDecisions)
      .innerJoin(tenants, eq(tenants.id, routingDecisions.tenantId))
      .where(where)
      .orderBy(desc(routingDecisions.id))
      .limit(limit)
      .offset(offset)
      .then((rows) =>
        rows.map((row) => ({ ...plainDecision(row.d), tenant: row.tenant })),
      );

    return { rows, total, limit, offset, facets: { tenants: names, fallback: ["fired", "quiet"] } };
  });

  /** Per-key spend grouped over metering rows (today), paged — the see-all
      page behind the per-key table. Grouped rows can't be offset in SQL
      cheaply, so the count walks the same grouping in a subquery. */
  app.get("/v1/console/observability/keys", { onRequest: consoleRoute }, async (req) => {
    adminOnly(req);
    const { q, limit, offset, tenant } = pageParams(req);
    const { ids, names } = await tenantIdFilter(tenant);
    const conditions = [
      inArray(requests.tenantId, ids.length ? ids : [-1]),
      sql`substr(${requests.createdAt}, 1, 10) = ${utcDay()}`,
    ];
    if (q) conditions.push(like(requests.keyLabel, `%${q}%`));
    const where = and(...conditions);

    const grouped = db
      .select({ tenantId: requests.tenantId, label: requests.keyLabel })
      .from(requests)
      .where(where)
      .groupBy(requests.tenantId, requests.keyLabel)
      .as("grouped");

    const total = await db.select({ n: sql<number>`count(*)` }).from(grouped).then((r) => r[0]?.n ?? 0);

    const spend = sql<number>`coalesce(sum(${requests.estimatedCostUsd}), 0)`;
    const rows = await db
      .select({
        tenant: tenants.name,
        label: requests.keyLabel,
        requests: sql<number>`count(*)`,
        tokens: sql<number>`coalesce(sum(${requests.promptTokens} + ${requests.completionTokens}), 0)`,
        costUsd: spend,
        maskedKey: apiKeys.maskedKey,
      })
      .from(requests)
      .innerJoin(tenants, eq(tenants.id, requests.tenantId))
      .leftJoin(apiKeys, and(eq(apiKeys.tenantId, requests.tenantId), eq(apiKeys.label, requests.keyLabel)))
      .where(where)
      .groupBy(requests.tenantId, requests.keyLabel)
      .orderBy(desc(spend))
      .limit(limit)
      .offset(offset);

    return { rows, total, limit, offset, facets: { tenants: names } };
  });

  /** Chart source for /observability and the see-all pages: one endpoint per
      the same domain the pages list, so a page's chart reflects its filters
      (same query params as the matching list endpoint, minus paging).
      Time domains bucket on the ISO prefix of created_at (hour for 24h, day
      for 30d) — the same scan the quota's utc_day does. The keys domain is
      categorical: buckets are the top key names by metric, not time. */
  app.get("/v1/console/observability/series", { onRequest: consoleRoute }, async (req) => {
    adminOnly(req);
    const p = req.query as Record<string, string | undefined>;
    const metric = p.metric?.trim() || "requests";
    const domain = p.domain?.trim() || "turns";
    const window = p.window === "30d" ? "30d" : "24h";
    const tenant = p.tenant?.trim() || undefined;

    const { ids, names } = await tenantIdFilter(tenant);
    const tenantIn = (col: AnySQLiteColumn) => inArray(col, ids.length ? ids : [-1]);

    if (domain === "keys") {
      // spend/requests per key name (today), stacked per tenant
      const conditions = [
        tenantIn(requests.tenantId),
        sql`substr(${requests.createdAt}, 1, 10) = ${utcDay()}`,
      ];
      if (p.q?.trim()) conditions.push(like(requests.keyLabel, `%${p.q.trim().slice(0, 120)}%`));
      const value =
        metric === "costUsd"
          ? sql<number>`coalesce(sum(${requests.estimatedCostUsd}), 0)`
          : sql<number>`count(*)`;
      const spend = sql<number>`coalesce(sum(${requests.estimatedCostUsd}), 0)`;
      const rows = await db
        .select({ bucket: requests.keyLabel, tenant: tenants.name, value })
        .from(requests)
        .innerJoin(tenants, eq(tenants.id, requests.tenantId))
        .where(and(...conditions))
        .groupBy(requests.tenantId, requests.keyLabel)
        .then((r) => r.map((row) => ({ ...row, value: Number(row.value) })));
      // top keys by metric, so the chart stays readable however many keys exist
      const ranked = [...new Set(rows.map((r) => r.bucket ?? "unknown"))]
        .map((label) => ({ label, total: rows.filter((r) => (r.bucket ?? "unknown") === label).reduce((s, r) => s + r.value, 0) }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
        .map((k) => k.label);
      const buckets = ranked;
      const series = new Map<string, number[]>();
      for (const name of names) series.set(name, new Array(buckets.length).fill(0));
      for (const r of rows) {
        const label = r.bucket ?? "unknown";
        const i = buckets.indexOf(label);
        const values = series.get(r.tenant);
        if (values && i >= 0) values[i] = r.value;
      }
      return pack({ domain, metric, bucketKind: "category", buckets,
        series: Array.from(series, ([tenantName, values]) => ({ tenant: tenantName, values })).sort((a, b) => a.tenant.localeCompare(b.tenant)), total: rows.filter((r) => buckets.includes(r.bucket ?? "unknown")).reduce((s, r) => s + r.value, 0) });
    }

    // time domains
    /** Bucket geometry: the window presets are relative to now; an explicit
        from/to day range (the pages' date pickers) wins and is anchored to
        its own day boundaries — hourly if the span is ≤ 2 days, else daily. */
    const range = dayRangeParams(p);
    const explicit = range.from !== undefined || range.to !== undefined;
    const stepMs = explicit
      ? (Date.parse(`${range.to ?? range.from}T00:00:00Z`) - Date.parse(`${range.from ?? range.to}T00:00:00Z`)) / 86_400_000 <= 2 ? 3_600_000 : 86_400_000
      : window === "30d" ? 86_400_000 : 3_600_000;
    const bucketLen = stepMs === 86_400_000 ? 10 : 13; // YYYY-MM-DD | YYYY-MM-DDTHH
    const startMs = explicit
      ? Date.parse(`${range.from ?? range.to}T00:00:00Z`)
      : Date.now() - (stepMs === 86_400_000 ? 29 * stepMs : 23 * stepMs);
    const endMs = explicit ? Date.parse(`${range.to ?? range.from}${bucketLen === 13 ? "T23:00:00Z" : "T00:00:00Z"}`) : Date.now();
    const buckets: string[] = [];
    for (let t = startMs; t <= endMs; t += stepMs) {
      buckets.push(new Date(t).toISOString().slice(0, bucketLen));
    }
    const from = buckets[0]!;

    if (domain === "sessions") {
      const conditions = [tenantIn(chatSessions.tenantId), gte(chatSessions.createdAt, from)];
      if (p.state === "active") conditions.push(isNull(chatSessions.deletedAt));
      if (p.state === "deleted") conditions.push(isNotNull(chatSessions.deletedAt));
      if (p.q?.trim()) {
        const q = p.q.trim().slice(0, 120);
        conditions.push(or(like(chatSessions.title, `%${q}%`), like(chatSessions.externalId, `%${q}%`))!);
      }
      const rows = await db
        .select({ bucket: sql<string>`substr(${chatSessions.createdAt}, 1, ${bucketLen})`, tenant: tenants.name, value: sql<number>`count(*)` })
        .from(chatSessions)
        .innerJoin(tenants, eq(tenants.id, chatSessions.tenantId))
        .where(and(...conditions))
        .groupBy(sql`substr(${chatSessions.createdAt}, 1, ${bucketLen})`, tenants.id)
        .then((r) => r.map((row) => ({ ...row, value: Number(row.value) })));
      return pack({ domain, metric: "sessions", bucketKind: "time", buckets, series: fill(rows, names, buckets), total: rows.reduce((s, r) => s + r.value, 0) });
    }

    if (domain === "decisions") {
      const conditions = [tenantIn(routingDecisions.tenantId), gte(routingDecisions.createdAt, from)];
      if (p.capability?.trim()) conditions.push(eq(routingDecisions.capability, p.capability.trim()));
      if (p.fallback === "fired") conditions.push(eq(routingDecisions.fallbackTriggered, true));
      if (p.fallback === "quiet") conditions.push(eq(routingDecisions.fallbackTriggered, false));
      if (p.q?.trim()) {
        const q = p.q.trim().slice(0, 120);
        conditions.push(or(like(routingDecisions.requestId, `%${q}%`), like(routingDecisions.chosenBackendId, `%${q}%`))!);
      }
      const value =
        metric === "fallbacks"
          ? sql<number>`sum(case when ${routingDecisions.fallbackTriggered} then 1 else 0 end)`
          : sql<number>`count(*)`;
      const rows = await db
        .select({ bucket: sql<string>`substr(${routingDecisions.createdAt}, 1, ${bucketLen})`, tenant: tenants.name, value })
        .from(routingDecisions)
        .innerJoin(tenants, eq(tenants.id, routingDecisions.tenantId))
        .where(and(...conditions))
        .groupBy(sql`substr(${routingDecisions.createdAt}, 1, ${bucketLen})`, tenants.id)
        .then((r) => r.map((row) => ({ ...row, value: Number(row.value) })));
      return pack({ domain, metric: metric === "fallbacks" ? "fallbacks" : "requests", bucketKind: "time", buckets, series: fill(rows, names, buckets), total: rows.reduce((s, r) => s + r.value, 0) });
    }

    // turns (the activity domain — also the home chart)
    const conditions = [tenantIn(requests.tenantId), gte(requests.createdAt, from)];
    if (p.outcome?.trim()) conditions.push(eq(requests.outcome, p.outcome.trim()));
    if (p.capability?.trim()) conditions.push(eq(requests.capability, p.capability.trim()));
    if (p.q?.trim()) {
      const q = p.q.trim().slice(0, 120);
      conditions.push(
        or(like(requests.question, `%${q}%`), like(requests.id, `%${q}%`), like(requests.modelId, `%${q}%`), like(requests.keyLabel, `%${q}%`))!,
      );
    }

    /** Tail latency + streaming shape: percentiles can't be summed, so per
        bucket this ranks raw rows in JS — SQLite's percentile functions live
        in optional extensions, and at metering-table scale the row scan is
        cheaper than depending on one. A bucket with no qualifying rows reads
        as `null` (a gap the line skips), never as 0 ms of latency. `total` is
        the whole window's percentile, which is the number worth reading, not
        a sum of buckets. */
    if (metric === "latencyP95" || metric === "ttftP95" || metric === "tpotP95" || metric === "tpsP50") {
      const raw = await db
        .select({
          bucket: sql<string>`substr(${requests.createdAt}, 1, ${bucketLen})`,
          tenant: tenants.name,
          latencyMs: requests.latencyMs,
          ttftMs: requests.ttftMs,
          completionTokens: requests.completionTokens,
        })
        .from(requests)
        .innerJoin(tenants, eq(tenants.id, requests.tenantId))
        .where(and(...conditions));

      /** The sample this metric ranks, in the metric's unit. End-to-end ms,
          first-token ms, decode ms per output token (TTFT excluded — that is
          not decoding), or output tokens/s. Rows the metric can't judge (no
          first token, no output tokens) drop out rather than faking a 0. */
      const sample = (r: (typeof raw)[number]): number | null => {
        const decodeMs = r.ttftMs === null ? null : r.latencyMs - r.ttftMs;
        switch (metric) {
          case "latencyP95": return r.latencyMs;
          case "ttftP95":    return r.ttftMs;
          case "tpotP95":    return decodeMs && r.completionTokens > 0 ? decodeMs / r.completionTokens : null;
          case "tpsP50":     return decodeMs && r.completionTokens > 0 && decodeMs > 0
            ? r.completionTokens / (decodeMs / 1000) : null;
        }
      };
      const quantile = metric === "tpsP50" ? 0.5 : 0.95;

      const perBucket = new Map<string, number[]>();
      for (const r of raw) {
        const v = sample(r);
        if (v === null) continue;
        const key = `${r.bucket}|${r.tenant}`;
        const rows = perBucket.get(key) ?? [];
        rows.push(v);
        perBucket.set(key, rows);
      }
      const series = names.map((tenantName) => ({
        tenant: tenantName,
        values: buckets.map((b) => {
          const rows = perBucket.get(`${b}|${tenantName}`);
          return rows ? percentile(rows, quantile) : null;
        }),
      }));
      return pack({
        domain: "turns", metric, bucketKind: "time", buckets, series,
        total: percentile(raw.map(sample).filter((v): v is number => v !== null), quantile),
      });
    }

    const value =
      metric === "tokens"      ? sql<number>`coalesce(sum(${requests.promptTokens} + ${requests.completionTokens}), 0)`
      : metric === "costUsd"   ? sql<number>`coalesce(sum(${requests.estimatedCostUsd}), 0)`
      : sql<number>`count(*)`;
    const rows = await db
      .select({ bucket: sql<string>`substr(${requests.createdAt}, 1, ${bucketLen})`, tenant: tenants.name, value })
      .from(requests)
      .innerJoin(tenants, eq(tenants.id, requests.tenantId))
      .where(and(...conditions))
      .groupBy(sql`substr(${requests.createdAt}, 1, ${bucketLen})`, tenants.id)
      .then((r) => r.map((row) => ({ ...row, value: Number(row.value) })));
    return pack({ domain: "turns", metric, bucketKind: "time", buckets, series: fill(rows, names, buckets), total: rows.reduce((s, r) => s + r.value, 0) });

    /** zero-fill bucket ground so gaps read as flat, and every tenant gets a
        full-length array to stack — same as rows arrive grouped by bucket */
    function fill(rows: { bucket: string; tenant: string; value: number }[], tenantNames: string[], ks: string[]) {
      const out = new Map<string, number[]>(tenantNames.map((t) => [t, new Array(ks.length).fill(0)]));
      for (const r of rows) {
        const values = out.get(r.tenant);
        const i = ks.indexOf(r.bucket);
        if (values && i >= 0) values[i] = r.value;
      }
      return Array.from(out, ([tenantName, values]) => ({ tenant: tenantName, values })).sort((a, b) => a.tenant.localeCompare(b.tenant));
    }
    function pack(x: {
      domain: string; metric: string; bucketKind: "time" | "category";
      buckets: string[]; series: { tenant: string; values: (number | null)[] }[]; total: number;
    }) {
      return { ...x, window: domain === "keys" ? undefined : window };
    }
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
