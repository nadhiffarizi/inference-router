import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { apiKeys, tenants } from "../db/schema.js";
import { errors } from "../lib/errors.js";
import { checkQuota } from "../lib/quota.js";
import type { TenantRow } from "../lib/quota.js";

declare module "fastify" {
  interface FastifyRequest {
    tenant?: TenantRow;
  }
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

/**
 * API-key auth + quota, in one pre-serializer hook so both streaming and
 * non-stream routes get the identical request path (brief: correctness of
 * the request path). A key maps to exactly one tenant identity.
 *
 * Fails closed: unknown/malformed key → 401; over-quota → 429; and if the
 * quota *check itself* fails → 503 quota_uncertain rather than serving blind.
 */
export async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization;
  const match = typeof header === "string" ? BEARER_RE.exec(header) : null;
  let key: string | undefined;
  if (match) key = match[1];

  if (!key) {
    throw errors.unauthorized("Missing API key. Send 'Authorization: Bearer <tenant key>'.");
  }

  const keyHash = createHash("sha256").update(key).digest("hex");
  const row = await db
    .select({ tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1)
    .then((r) => r[0]);

  if (!row) throw errors.unauthorized("Unknown API key.");

  const tenant = await db.select().from(tenants).where(eq(tenants.id, row.tenantId)).limit(1).then((r) => r[0]);
  if (!tenant) throw errors.unauthorized("Key maps to an unknown tenant.");

  const quota = await checkQuota(tenant);
  if (!quota.allowed) {
    throw errors.quotaExceeded(quota.reason, {
      limit: {
        requestsPerDay: tenant.requestsPerDay,
        tokensPerDay: tenant.tokensPerDay,
      },
      used: quota.used,
      reset: "UTC midnight",
    });
  }

  req.tenant = { ...tenant, usage: quota.used };
}