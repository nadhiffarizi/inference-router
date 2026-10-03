import { useEffect, useState } from "react";
import { Copy, Plus } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";

/**
 * API-keys screen: issue a key (plaintext shown/copied exactly once), then
 * see the masked forms + the endpoint URLs to integrate against.
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

  async function generate(): Promise<void> {
    const issued = await issue();
    if (issued) setFresh(issued.apiKey);
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
          <CardTitle>api keys</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            The playground needs a key to call the gateway. Issue one, copy it, paste it into the playground
            — exactly how a product team integrates.
          </p>
          <Button size="sm" onClick={() => void generate()}>
            <Plus className="size-3.5" /> Generate API key
          </Button>

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

          <div className="mt-4">
            {keys.length === 0 ? (
              <p className="text-sm text-muted-foreground">No keys yet — generate one to start.</p>
            ) : (
              <ul className="divide-y">
                {keys.map((k) => (
                  <li key={k.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="font-mono text-sm">{k.maskedKey}</p>
                      <p className="text-xs text-muted-foreground">{k.label}</p>
                    </div>
                    <Badge variant="secondary">active</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
