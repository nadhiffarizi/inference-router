import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { quotaUsage, requests, routingDecisions, tenants } from "../db/schema.js";
import { authenticate } from "../plugins/auth.js";
import { utcDay } from "../lib/quota.js";

/**
 * The usage view the console renders (brief: "requests and cost per tenant,
 * and remaining quota") plus the routing decision log — the brief's "decision
 * recorded and inspectable" made visible. Any valid tenant key can read it
 * (internal surface, DECISIONS.md D10); tenant isolation lives on the request
 * path, not here.
 */

const UsageSchema = {
  type: "object",
  properties: {
    tenants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          today: {
            type: "object",
            properties: {
              requests: { type: "integer" },
              tokens: { type: "integer" },
              costsUsd: { type: "number" },
            },
          },
          quota: { type: "object", properties: { requestsPerDay: { type: "integer" }, tokensPerDay: { type: "integer" } } },
          remaining: { type: "object", properties: { requests: { type: "integer" }, tokens: { type: "integer" } } },
          totals: { type: "object", properties: { requests: { type: "integer" }, costUsd: { type: "number" } } },
          byCapability: {
            type: "array",
            items: {
              type: "object",
              properties: { capability: { type: "string" }, requests: { type: "integer" } },
            },
          },
          byOutcome: {
            type: "array",
            items: {
              type: "object",
              properties: { outcome: { type: "string" }, requests: { type: "integer" } },
            },
          },
        },
      },
    },
    recentRoutingDecisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          tenantId: { type: "integer" },
          capability: { type: "string" },
          plan: {
            type: "array",
            items: {
              type: "object",
              properties: {
                backendId: { type: "string" },
                action: { type: "string" },
                reason: { type: "string" },
              },
            },
          },
          chosenBackendId: { type: ["string", "null"] },
          fallbackTriggered: { type: "boolean" },
          createdAt: { type: "string" },
        },
      },
    },
  },
} as const;

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get(
    "/v1/usage",
    { schema: { response: { 200: UsageSchema } }, onRequest: authenticate },
    async () => {
      const day = utcDay();
      const allTenants = await db.select().from(tenants);

      const rows = await Promise.all(
        allTenants.map(async (t) => {
          const usage = await db
            .select()
            .from(quotaUsage)
            .where(sql`${quotaUsage.tenantId} = ${t.id} AND ${quotaUsage.day} = ${day}`)
            .limit(1)
            .then((r) => r[0]);

          const totals = await db
            .select({
              requests: sql<number>`count(*)`,
              costUsd: sql<number>`coalesce(sum(${requests.estimatedCostUsd}), 0)`,
            })
            .from(requests)
            .where(eq(requests.tenantId, t.id))
            .then((r) => r[0] ?? { requests: 0, costUsd: 0 });

          const byCapability = await db
            .select({ capability: requests.capability, requests: sql<number>`count(*)` })
            .from(requests)
            .where(eq(requests.tenantId, t.id))
            .groupBy(requests.capability);

          const byOutcome = await db
            .select({ outcome: requests.outcome, requests: sql<number>`count(*)` })
            .from(requests)
            .where(eq(requests.tenantId, t.id))
            .groupBy(requests.outcome);

          return {
            id: t.id,
            name: t.name,
            today: {
              requests: usage?.requestCount ?? 0,
              tokens: usage?.tokensTotal ?? 0,
              costsUsd: 0, // set below from requests table (cost isn't in quota_usage)
            },
            quota: { requestsPerDay: t.requestsPerDay, tokensPerDay: t.tokensPerDay },
            remaining: {
              requests: Math.max(0, t.requestsPerDay - (usage?.requestCount ?? 0)),
              tokens: Math.max(0, t.tokensPerDay - (usage?.tokensTotal ?? 0)),
            },
            totals,
            byCapability,
            byOutcome,
          };
        }),
      );

      // Costs per tenant today come from the requests table.
      const costToday = await db
        .select({
          tenantId: requests.tenantId,
          costUsd: sql<number>`coalesce(sum(${requests.estimatedCostUsd}), 0)`,
        })
        .from(requests)
        .groupBy(requests.tenantId);
      const costByTenant = new Map(costToday.map((r) => [r.tenantId, r.costUsd]));

      const decisions = await db
        .select()
        .from(routingDecisions)
        .orderBy(desc(routingDecisions.id))
        .limit(25)
        .then((rows) =>
          rows.map((r) => ({
            ...r,
            plan: JSON.parse(r.planJson) as unknown[],
            planJson: undefined,
          })),
        );

      return {
        tenants: rows.map((r) => ({ ...r, today: { ...r.today, costsUsd: costByTenant.get(r.id) ?? 0 } })),
        recentRoutingDecisions: decisions,
      };
    },
  );
}