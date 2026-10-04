import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatSessions, requests } from "../db/schema.js";

/**
 * Session grouping (Langfuse logic, own implementation):
 *  - the IDENTIFIER belongs to the caller (playground-issued uuid, or the
 *    tenant's own ticket/chat id) — "grouping on first sight": first request
 *    carrying an unseen id creates the session, later ones join it;
 *  - sessions are tenant-scoped (unique per tenant — another tenant's
 *    "ticket-4821" never collides and can never be attached to);
 *  - deletion is soft: hidden from the product surface, retained for ops.
 */

export type ChatSessionRow = typeof chatSessions.$inferSelect;

const MAX_ID_LENGTH = 100;

/** Accepts a caller-declared id; returns the row it should attach to (or null). */
export async function resolveOrCreateSession(
  tenantId: number,
  externalId: string | undefined,
  firstQuestion: string,
): Promise<ChatSessionRow | null> {
  const id = externalId?.trim();
  if (!id || id.length > MAX_ID_LENGTH) return null;

  const now = new Date().toISOString();
  const existing = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.tenantId, tenantId), eq(chatSessions.externalId, id)))
    .limit(1)
    .then((r) => r[0]);
  if (existing) {
    // deleted sessions get revived when a caller returns to them
    await db.update(chatSessions).set({ updatedAt: now, deletedAt: null }).where(eq(chatSessions.uid, existing.uid));
    return { ...existing, deletedAt: null, updatedAt: now };
  }

  const inserted = await db
    .insert(chatSessions)
    .values({
      tenantId,
      externalId: id,
      title: firstQuestion.slice(0, 80),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((r) => r[0]);
  return inserted ?? null;
}

/** Own-tenant list (active and deleted — the tenant surface filters). */
export async function listSessions(
  tenantId: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<(ChatSessionRow & { turns: number; spendUsd: number })[]> {
  const conditions = [eq(chatSessions.tenantId, tenantId)];
  if (!opts.includeDeleted) conditions.push(isNull(chatSessions.deletedAt));
  return db
    .select({
      uid: chatSessions.uid,
      tenantId: chatSessions.tenantId,
      externalId: chatSessions.externalId,
      title: chatSessions.title,
      createdAt: chatSessions.createdAt,
      updatedAt: chatSessions.updatedAt,
      deletedAt: chatSessions.deletedAt,
      turns: sql<number>`(SELECT count(*) FROM requests WHERE requests.chat_session_uid = ${chatSessions.uid})`,
      spendUsd: sql<number>`(SELECT coalesce(sum(estimated_cost_usd), 0) FROM requests WHERE requests.chat_session_uid = ${chatSessions.uid})`,
    })
    .from(chatSessions)
    .where(and(...conditions))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(100);
}

/**
 * The session's turns, chronological, with full trace payloads.
 * tenantId guards tenancy; pass 0 (or omit) only for the admin cross-tenant
 * view (route enforces the role before calling).
 */
export async function sessionTurns(
  uid: number,
  tenantId?: number,
): Promise<{
  session: ChatSessionRow;
  turns: {
    id: string;
    createdAt: string;
    capability: string;
    keyLabel: string | null;
    backendId: string;
    modelId: string;
    tokens: number;
    costUsd: number;
    latencyMs: number;
    outcome: string;
    question: string | null;
    answer: string | null;
    retrieval: { id: number; question: string; answer: string; intent: string }[] | null;
    retrievalConfidence: number | null;
    intent: string | null;
    error: string | null;
  }[];
} | null> {
  const session = await db
    .select()
    .from(chatSessions)
    .where(
      tenantId
        ? and(eq(chatSessions.tenantId, tenantId), eq(chatSessions.uid, uid))
        : eq(chatSessions.uid, uid),
    )
    .limit(1)
    .then((r) => r[0]);
  if (!session) return null;

  const turns = await db
    .select()
    .from(requests)
    .where(eq(requests.chatSessionUid, uid))
    .orderBy(requests.createdAt);

  return {
    session,
    turns: turns.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      capability: r.capability,
      keyLabel: r.keyLabel,
      backendId: r.backendId,
      modelId: r.modelId,
      tokens: r.promptTokens + r.completionTokens,
      costUsd: r.estimatedCostUsd,
      latencyMs: r.latencyMs,
      outcome: r.outcome,
      question: r.question,
      answer: r.answer,
      retrieval: r.retrievalJson ? (JSON.parse(r.retrievalJson) as { id: number; question: string; answer: string; intent: string }[]) : null,
      retrievalConfidence: r.confidence,
      intent: r.intent,
      error: r.error,
    })),
  };
}

export async function softDeleteSession(tenantId: number, uid: number): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db
    .update(chatSessions)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(chatSessions.tenantId, tenantId), eq(chatSessions.uid, uid), isNull(chatSessions.deletedAt)))
    .returning({ uid: chatSessions.uid })
    .then((r) => r[0]);
  return Boolean(res);
}