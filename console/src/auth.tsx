import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Session state for the console. The session lives in an httpOnly cookie;
 * the gate below just asks /v1/console/me who's logged in. 401 → login page.
 */

/** The playground's persisted per-account state (the connection key and the
    chat session id). Names shared with playground.tsx which imports them —
    one definition, so login/logout clears exactly what the playground writes. */
export const PLAYGROUND_KEY_STORAGE = "playground.key";
export const PLAYGROUND_SESSION_STORAGE = "playground.sessionExternalId";

/** A stored playground key belongs to ONE account/tenant — letting it cross a
    login boundary means the next user's sends die on "Unknown API key" before
    quota can even be evaluated (the zero@demo.local 401-instead-of-429 bug).
    Every login/logout starts the playground clean: copy the key from the API
    Keys page, then connect — a deterministic flow, no silent carry-over. */
function forgetPlaygroundState(): void {
  localStorage.removeItem(PLAYGROUND_KEY_STORAGE);
  localStorage.removeItem(PLAYGROUND_SESSION_STORAGE);
}

export type ConsoleMe = {
  user: {
    email: string;
    role: "admin" | "product";
    tenant: { id: number; name: string; requestsPerDay: number; tokensPerDay: number; budgetUsdPerDay: number };
  };
  usage: { requestCount: number; tokensTotal: number; usdSpend: number; day: string };
};

type AuthState = {
  me: ConsoleMe | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({ me: null, loading: true, refresh: async () => undefined, logout: async () => undefined });

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [me, setMe] = useState<ConsoleMe | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/v1/console/me");
      setMe(res.ok ? ((await res.json()) as ConsoleMe) : null);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch("/v1/console/logout", { method: "POST" });
    forgetPlaygroundState();
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <AuthContext.Provider value={{ me, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export async function login(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/v1/console/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) {
    forgetPlaygroundState(); // the new account starts with a clean playground
    return { ok: true };
  }
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, error: data?.error?.message ?? `HTTP ${res.status}` };
}