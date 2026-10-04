import { useState } from "react";
import { Network } from "lucide-react";
import { login } from "./auth";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { Input } from "./components/ui/input";

/**
 * The login gate. Demo accounts are seeded and shared on purpose (README) so
 * an assessor can step through the product-team flow without provisioning.
 */

export function LoginView({ onLoggedIn }: { onLoggedIn: () => void }): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await login(email, password);
    setBusy(false);
    if (result.ok) onLoggedIn();
    else setError(result.error ?? "login failed");
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <div className="mb-6 flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Network className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold">Inference Router</p>
              <p className="text-xs text-muted-foreground">console</p>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-3">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
              autoComplete="username"
              required
            />
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              autoComplete="current-password"
              required
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="mt-4 text-xs text-muted-foreground">
            Demo accounts (credentials in the report's docs):<br />
            <code>team@demo.local</code> — product team view<br />
            <code>admin@demo.local</code> — product view <span className="font-medium">+ observability</span><br />
            <code>zero@demo.local</code> — product view on a zero-quota tenant (the 429 demo)
          </p>
        </CardContent>
      </Card>
    </div>
  );
}