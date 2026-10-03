import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { sessions, tenants, users } from "../db/schema.js";
import { config } from "../config.js";
import { errors } from "./errors.js";
import { readUsage } from "./quota.js";

/**
 * Session auth for the console surface: opaque token in an httpOnly cookie,
 * row in `sessions`, 30-day expiry (long-lived on purpose for this demo).
 * No JWT — nothing here needs stateless verification or third-party audience.
 *
 * Console endpoints and product-flows stay separate by design: /v1/chat and
 * /v1/support-assistant keep API-key auth; /v1/console/* is session auth.
 */

export type ConsoleUser = {
  id: number;
  email: string;
  role: "admin" | "product";
  tenant: { id: number; name: string; requestsPerDay: number; tokensPerDay: number; budgetUsdPerDay: number };
  usage: { requestCount: number; tokensTotal: number; day: string };
};

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.sessionCookie.days * 86_400_000).toISOString();
  await db.insert(sessions).values({ token, userId, expiresAt, createdAt: new Date().toISOString() });
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}

async function resolveUser(token: string): Promise<ConsoleUser | null> {
  const row = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date().toISOString())))
    .limit(1)
    .then((r) => r[0]);
  if (!row) return null;

  const user = await db.select().from(users).where(eq(users.id, row.userId)).limit(1).then((r) => r[0]);
  if (!user) return null;
  const tenant = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1).then((r) => r[0]);
  if (!tenant) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role as ConsoleUser["role"],
    tenant: {
      id: tenant.id,
      name: tenant.name,
      requestsPerDay: tenant.requestsPerDay,
      tokensPerDay: tenant.tokensPerDay,
      budgetUsdPerDay: tenant.budgetUsdPerDay,
    },
    usage: await readUsage(tenant.id),
  };
}

/** Reads the cookie; fails closed with a structured 401. */
export async function consoleAuth(req: FastifyRequest): Promise<ConsoleUser> {
  const token = (req.cookies as Record<string, string | undefined>)?.[config.sessionCookie.name];
  const user = token ? await resolveUser(token) : null;
  if (!user) throw errors.unauthorized("Session invalid or expired — log in again.");
  return user;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(config.sessionCookie.name, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: config.sessionCookie.days * 86_400,
    secure: config.sessionCookie.secure,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.sessionCookie.name, { path: "/" });
}

declare module "fastify" {
  interface FastifyRequest {
    cookies: Record<string, string | undefined>;
  }
}