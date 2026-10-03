import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Session state for the console. The session lives in an httpOnly cookie;
 * the gate below just asks /v1/console/me who's logged in. 401 → login page.
 */

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
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, error: data?.error?.message ?? `HTTP ${res.status}` };
}