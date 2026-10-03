import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

/**
 * Console password hashing with node:crypto scrypt — no external dependency.
 * (Not bcrypt/argon2; for a demo scale this is the honest minimal choice,
 * and the format is upgradeable: "scrypt:salt:hex".)
 */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, digest] = parts;
  if (!salt || !digest) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Issue + verify a console account in one query each. */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<{ id: number; email: string; role: string; tenantId: number } | null> {
  const user = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).limit(1).then((r) => r[0]);
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId };
}

/** New API key: plaintext shown to the issuer exactly once; DB stores hash+mask. */
export function generateApiKey(): { key: string; keyHash: string; masked: string } {
  const key = `sk_${randomBytes(24).toString("base64url")}`;
  return {
    key,
    keyHash: createHash("sha256").update(key).digest("hex"),
    masked: maskKey(key),
  };
}

/** "sk_abcdE…wxyz" — enough to recognize a key in a list, useless to steal with. */
export function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "…".repeat(3);
}