import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { quotaUsage, requests } from "../db/schema.js";

/**
 * Fixed-window (UTC day) quota. Deliberately simple (DECISIONS.md D10).
 * Counters: requests/day (bumped after metering), tokens/day, and since the
 * console redesign, a USD spend budget/day (computed from the metering
 * rows — the same currency the system actually records, no credits layer).
 *
 * "Fails closed" has two layers here:
 *  1. Over limit → deny with a clear 429 (the brief's explicit ask).
 *  2. If the check itself throws (DB unavailable) → the caller denies.
 *     Serving while unable to verify quota would be failing open.
 */

export type TenantRow = {
  id: number;
  name: string;
  requestsPerDay: number;
  tokensPerDay: number;
  budgetUsdPerDay: number;
  createdAt?: string;
  usage?: { requestCount: number; tokensTotal: number; usdSpend: number; day: string };
};

export type QuotaVerdict =
  | { allowed: true; used: { requestCount: number; tokensTotal: number; usdSpend: number; day: string } }
  | { allowed: false; reason: string; used: { requestCount: number; tokensTotal: number; usdSpend: number; day: string } };

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function readUsage(
  tenantId: number,
): Promise<{ requestCount: number; tokensTotal: number; usdSpend: number; day: string }> {
  const day = utcDay();
  const row = await db
    .select()
    .from(quotaUsage)
    .where(and(eq(quotaUsage.tenantId, tenantId), eq(quotaUsage.day, day)))
    .limit(1)
    .then((r) => r[0]);

  // Daily USD spend from metering rows — single source of truth for cost.
  const spend = await db
    .select({ costUsd: sql<number>`coalesce(sum(${requests.estimatedCostUsd}), 0)` })
    .from(requests)
    .where(and(eq(requests.tenantId, tenantId), sql`substr(${requests.createdAt}, 1, 10) = ${day}`))
    .then((r) => r[0]?.costUsd ?? 0);

  return {
    requestCount: row?.requestCount ?? 0,
    tokensTotal: row?.tokensTotal ?? 0,
    usdSpend: spend,
    day,
  };
}

export async function checkQuota(
  tenant: Pick<TenantRow, "id" | "requestsPerDay" | "tokensPerDay" | "budgetUsdPerDay">,
): Promise<QuotaVerdict> {
  try {
    const used = await readUsage(tenant.id);
    if (used.requestCount + 1 > tenant.requestsPerDay) {
      return { allowed: false, reason: "Daily request quota exhausted.", used };
    }
    if (used.tokensTotal >= tenant.tokensPerDay) {
      return { allowed: false, reason: "Daily token quota exhausted.", used };
    }
    if (tenant.budgetUsdPerDay > 0 && used.usdSpend >= tenant.budgetUsdPerDay) {
      return {
        allowed: false,
        reason: `Daily spending budget ($${tenant.budgetUsdPerDay}) exhausted.`,
        used,
      };
    }
    return { allowed: true, used };
  } catch (err) {
    // Fail closed: a quota system that cannot verify should deny, not assume.
    throw new Error(`quota check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Bump counters after a served/refused-but-billed request. */
export async function bumpQuota(
  tenantId: number,
  tokens: number,
): Promise<void> {
  const day = utcDay();
  await db
    .insert(quotaUsage)
    .values({ tenantId, day, requestCount: 1, tokensTotal: tokens })
    .onConflictDoUpdate({
      target: [quotaUsage.tenantId, quotaUsage.day],
      set: {
        requestCount: sql`${quotaUsage.requestCount} + 1`,
        tokensTotal: sql`${quotaUsage.tokensTotal} + ${tokens}`,
      },
    });
}