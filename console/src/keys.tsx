import { useEffect, useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";

/**
 * API-keys screen — one account, one key, irreplaceable (openrouter-simple):
 * no key yet → issue via a named dialog; afterwards the mask is shown and
 * that's final (lost keys → reset demo fixtures).
 */

export type KeyRow = { id: number; maskedKey: string; label: string; createdAt: string };
export type Endpoints = { path: string; url: string; description: string }[];

export function useKeys(): {
  keys: KeyRow[];
  endpoints: Endpoints;
  reload: () => Promise<void>;
  issue: (label?: string) => Promise<{ apiKey: string; maskedKey: string } | null>;
  error: string | null;
} {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoints>([]);
  const [error, setError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    const res = await fetch("/v1/console/keys");
    if (!res.ok) {
      setError(`HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as { keys: KeyRow[]; endpoints: Endpoints };
    setKeys(data.keys);
    setEndpoints(data.endpoints);
    setError(null);
  }

  async function issue(label?: string): Promise<{ apiKey: string; maskedKey: string } | null> {
    const res = await fetch("/v1/console/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(label ? { label } : {}),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(data?.error?.message ?? `HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { apiKey: string; maskedKey: string };
    await reload();
    return data;
  }

  useEffect(() => {
    void reload();
  }, []);

  return { keys, endpoints, reload, issue, error };
}

export function ApiKeysView(): React.ReactElement {
  const { keys, endpoints, issue, error } = useKeys();
  const [fresh, setFresh] = useState<string | null>(null); // plaintext shown once
  const [copied, setCopied] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const active = keys[0];

  async function issueNamed(): Promise<void> {
    const label = name.trim();
    if (!label) return;
    setBusy(true);
    const issued = await issue(label);
    setBusy(false);
    if (issued) {
      setFresh(issued.apiKey);
      setDialogOpen(false);
      setName("");
    }
  }

  async function copy(text: string, what: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1600);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 pt-5">
      <Card>
        <CardHeader>
          <CardTitle>API key</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            One account, one key — irreplaceable. It authenticates product flows and is tracked by name in
            usage and observability. If the plaintext is lost, regenerate via fresh fixtures (demo scope).
          </p>

          {active ? (
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{active.label}</p>
                  <p className="font-mono text-xs text-muted-foreground">{active.maskedKey}</p>
                </div>
                <Badge variant="success">active</Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">issued {active.createdAt.slice(0, 10)}</p>
            </div>
          ) : (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <KeyRound className="size-3.5" /> Issue a key
            </Button>
          )}

          {/* named-issue dialog (only reachable while no key exists — keys are irreplaceable) */}
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Issue a key</DialogTitle>
                <DialogDescription>
                  Name it so you'll recognize it in the usage and observability views — e.g. mobile-app-prod.
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void issueNamed();
                }}
                className="space-y-3"
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="key name"
                  autoFocus
                  maxLength={80}
                  required
                />
                <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
                  {busy ? "issuing…" : "Create key"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>

          {fresh && (
            <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Copy now — shown once, never again</p>
                <Button size="sm" variant="outline" onClick={() => void copy(fresh, "fresh")}>
                  <Copy className="size-3" /> {copied === "fresh" ? "copied!" : "copy"}
                </Button>
              </div>
              <p className="mt-2 break-all font-mono text-sm">{fresh}</p>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>endpoints</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {endpoints.map((e) => (
            <div key={e.path} className="flex items-center justify-between gap-3 rounded-lg border p-2.5">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{e.path}</p>
                <p className="text-xs text-muted-foreground">{e.description}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void copy(e.url, e.path)}>
                {copied === e.path ? "copied" : <Copy className="size-3" />}
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Auth header: <code className="font-mono">Authorization: Bearer &lt;your key&gt;</code> · responses stream as SSE.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}