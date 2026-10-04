/**
 * Central env config — one place to read the environment, one place to say
 * what is required. The gateway fails fast at boot on missing required vars
 * (same fail-closed philosophy the quota enforces at request time).
 */

/** Minimal .env loader (no dependency): real env always wins over the file. */
function loadDotEnv(): void {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || !m[1] || !m[2]) continue;
      const k = m[1];
      const v = m[2];
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* no .env — env vars only */
  }
}
loadDotEnv();

import { readFileSync } from "node:fs";

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Env ${name} must be a non-negative number, got "${raw}"`);
  return n;
}

function req(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`Missing required env ${name} — see .env.example`);
  return raw;
}

/** Optional string env — unset/empty falls back to the given default. */
function str(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw || fallback;
}

const config_defaults = { requestQuota: 200 };

export const config = {
  port: num("PORT", 8787),
  dbPath: process.env.DB_PATH?.trim() || "data/gateway.sqlite",
  /**
   * When set (docker/single-process deploys), the gateway also serves the
   * built console from this directory — one origin, one process. Unset in
   * dev, where vite serves the console and proxies /v1.
   */
  consoleDist: process.env.CONSOLE_DIST?.trim() || "",

  openrouter: {
    apiKey: req("OPENROUTER_API_KEY"),
    baseUrl: (process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
  },

  /** Tier A: fast/cheap. Tier B: capable. Pinned via env at deploy time. */
  backends: {
    tierA: {
      id: "openrouter-tier-a",
      model: req("TIER_A_MODEL"),
      label: process.env.TIER_A_LABEL?.trim() || "Tier A · fast/cheap",
      timeoutMs: num("TIER_A_TIMEOUT_MS", 8_000),
      pricePerMTokens: priceEnv("TIER_A", { input: 0.05, output: 0.45 }),
    },
    tierB: {
      id: "openrouter-tier-b",
      model: req("TIER_B_MODEL"),
      label: process.env.TIER_B_LABEL?.trim() || "Tier B · capable",
      timeoutMs: num("TIER_B_TIMEOUT_MS", 20_000),
      pricePerMTokens: priceEnv("TIER_B", { input: 2, output: 8 }),
    },
    mock: {
      id: "mock",
      model: process.env.MOCK_MODEL?.trim() || "mock/instant",
      label: "Mock · scripted latency/failure",
      timeoutMs: num("MOCK_TIMEOUT_MS", 6_000),
      pricePerMTokens: priceEnv("MOCK", { input: 0, output: 0 }),
      chunkDelayMs: num("MOCK_CHUNK_DELAY_MS", 40),
      firstByteDelayMs: num("MOCK_FIRST_BYTE_DELAY_MS", 200),
      /** 0..1 — probability a call fails (error) vs succeeds. */
      failureRate: num("MOCK_FAILURE_RATE", 0),
      /** "none" = scripted delays only; "fail" = throw after first-byte delay; "hang" = never yield (exercises timeout→fallback). */
      failureMode: (process.env.MOCK_FAILURE_MODE?.trim() || "none") as "none" | "fail" | "hang",
    },
  },

  /**
   * Fallback chain override for demos: e.g. "mock,openrouter-tier-a,openrouter-tier-b"
   * makes mock first so the video shows a timeout → real-backend fallback fire.
   * Empty = policy order only.
   */
  routingChainOverride: process.env.ROUTING_CHAIN?.trim() || "",

  quota: {
    requestsPerDay: num("QUOTA_REQUESTS_PER_DAY", 200),
    tokensPerDay: num("QUOTA_TOKENS_PER_DAY", 500_000),
    /** Quota currency is USD (no credits layer — same unit the metering records). */
    budgetUsdPerDay: num("QUOTA_BUDGET_USD_PER_DAY", 1),
  },

  assistant: {
    /** Lexical retrieval settings (see DECISIONS.md D7 — no embeddings by design). */
    topK: num("RETRIEVAL_TOP_K", 5),
    /** Below this normalized confidence the assistant refuses instead of guessing.
     *  Calibrated against probe data: on-KB ≈ 0.48–0.79, off-KB ≈ 0.04–0.37 (rag/kb.ts). */
    refuseBelowConfidence: num("RETRIEVAL_REFUSE_BELOW", 0.48),
    /**
     * Refusal copy — policy text, NOT model output (the model is never called
     * when the gate refuses). One string per refusal path so the chat bubble,
     * the stored turn's answer, and the trace replay all quote the same thing:
     *   lowRetrieval — confidence under the floor, nothing worth grounding on;
     *   unusable     — a model DID answer, but its output was unusable/empty,
     *                  so the gateway served the policy refusal instead.
     */
    lowRetrievalRefusalMessage:
      str("ASSISTANT_REFUSAL_MESSAGE",
        "I don't have reliable information on that in the support knowledge base, so I won't guess. Could you rephrase, or contact support directly?"),
    unusableRefusalMessage: str("ASSISTANT_UNUSABLE_MESSAGE", "The model returned an unusable response, so I'm not answering it. Please try again."),
  },

  /** Seed tenants are fixtures (DECISIONS.md D10 — no tenant CRUD UI).
   *  Format: "name:key:requestsPerDay:budgetUsdPerDay" — quota currency is USD.
   *  key "-" = start WITHOUT a key (the console's issue flow becomes the real path). */
  seedTenants: (process.env.SEED_TENANTS?.trim() ||
    "ops:-:500:10, demo:-:200:1, stress:sk_stress_key_0000000000000000:3:0.05, eval:sk_eval_key_000000000000000000:500:1")
    .split(",")
    .map((entry) => {
      const [name, key, requests, budget] = entry.split(":");
      if (!name || !key) throw new Error(`Env SEED_TENANTS entries must be "name:key:requestsPerDay:budgetUsdPerDay"`);
      return {
        name: name.trim(),
        key: key.trim(),
        requestsPerDay: Number(requests) || config_defaults.requestQuota,
        budgetUsdPerDay: budget !== undefined && budget !== "" ? Number(budget) : null,
      };
    }),

  /** Console accounts: "email:password:role:tenantName". Shared demo creds are fine. */
  seedUsers: (process.env.SEED_USERS?.trim() ||
    "admin@demo.local:mekari-demo-2026:admin:ops, team@demo.local:mekari-demo-2026:product:demo")
    .split(",")
    .map((entry) => {
      const [email, password, role, tenantName] = entry.split(":");
      if (!email || !password || !role || !tenantName) {
        throw new Error(`Env SEED_USERS entries must be "email:password:role:tenantName"`);
      }
      if (role !== "admin" && role !== "product") throw new Error(`Role must be admin|product, got ${role}`);
      return { email: email.trim(), password, role, tenantName: tenantName.trim() };
    }),

  sessionCookie: {
    name: "session",
    days: 30,
    /** Set when a proxy (NGINX+Cloudflare) terminates TLS in front of the origin. */
    secure: process.env.COOKIE_SECURE?.trim() === "true",
  },
};

function priceEnv(prefix: string, fallback: { input: number; output: number }) {
  const inRaw = process.env[`${prefix}_PRICE_IN`]?.trim();
  const outRaw = process.env[`${prefix}_PRICE_OUT`]?.trim();
  return {
    input: inRaw !== undefined && inRaw !== "" ? Number(inRaw) : fallback.input,
    output: outRaw !== undefined && outRaw !== "" ? Number(outRaw) : fallback.output,
  };
}

export type TierAConfig = typeof config.backends.tierA;
export type TierBConfig = typeof config.backends.tierB;
export type MockConfig = typeof config.backends.mock;