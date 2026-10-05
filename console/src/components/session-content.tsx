import { KeyValBadge } from "./ui/key-val-badge";
import { outcomeBadge } from "../lib/badges";
import { usd } from "../lib/utils";
import { localTime } from "../lib/time";
import type { Turn } from "../api";
import { Bubble, Markdown } from "../lib/chatui";

/**
 * The session timeline's body — turns in order with a full trace on each. The
 * dialog (home) and the right drawer (see-all pages) both render this.
 */

export function SessionContent({ turns }: { turns: Turn[] }): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {turns.map((t) => (
        <div key={t.id} className="rounded-lg border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">{localTime(t.createdAt)}</span>
            <KeyValBadge label="status" value={t.outcome} variant={outcomeBadge(t.outcome)} />
            {t.intent && <KeyValBadge label="intent" value={t.intent} variant="success" />}
            <KeyValBadge label="backend" value={t.backendId} variant="outline" />
            <KeyValBadge label="model" value={t.modelId.split("/").pop() ?? "none"} variant="outline" />
            <KeyValBadge label="auth" value={t.keyLabel ?? "none"} />
            <span className="ml-auto text-[10px] text-muted-foreground">{usd(t.costUsd)} · {t.latencyMs} ms</span>
          </div>
          <div className="space-y-2">
            <Bubble role="user">{t.question ?? "(not recorded)"}</Bubble>
            {t.answer ? <Bubble role="assistant"><Markdown text={t.answer} /></Bubble> : t.error ? <Bubble role="assistant" tone="error">{t.error}</Bubble> : null}
          </div>
          {t.retrieval && t.retrieval.length > 0 && (
            <p className="mt-2 truncate text-[10px] text-muted-foreground">
              retrieved: {t.retrieval.map((e) => e.intent).join(", ")} · confidence {t.retrievalConfidence?.toFixed(2)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}