import { Badge } from "./ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { outcomeBadge } from "../lib/badges";
import { usd } from "../lib/utils";
import { Bubble } from "../lib/chatui";

/**
 * The one trace view (Langfuse-mini, shared): the stored chat turn —
 * question, answer, what was retrieved, how it was routed, what it cost.
 * The playground opens it from any bubble; observability opens it from the
 * activity feed. One component, so a turn always looks the same.
 */

export type TracePayload = {
  id: string;
  createdAt: string;
  capability?: string;
  keyLabel?: string | null;
  backendId?: string;
  modelId?: string;
  tokens?: number;
  costUsd?: number;
  latencyMs?: number;
  outcome?: string;
  question?: string | null;
  answer?: string | null;
  retrievalConfidence?: number | null;
  retrieval?: { id: number; question: string; answer: string; intent: string }[] | null;
  intent?: string | null;
  error?: string | null;
  plan?: { backendId: string; action: string; reason: string }[];
  fallbackTriggered?: boolean;
};

export function TraceDialog({ trace, onClose }: { trace: TracePayload | null; onClose: () => void }): React.ReactElement {
  return (
    <Dialog open={trace !== null} onOpenChange={(o) => !o && onClose()}>
      {/* flex+gap so the summary, turn, retrieval, routing and metering blocks separate */}
      <DialogContent className="flex max-w-2xl flex-col gap-4">
        {trace && (
          <>
            {/* mb-0: the flex gap covers the header's spacing */}
            <DialogHeader className="mb-0">
              <DialogTitle>trace · {trace.createdAt.slice(0, 19).replace("T", " ")} UTC</DialogTitle>
            </DialogHeader>

            {/* summary badges */}
            <div className="flex flex-wrap items-center gap-2">
              {trace.outcome && <Badge variant={outcomeBadge(trace.outcome)}>{trace.outcome}</Badge>}
              {trace.capability && (
                <Badge variant={trace.capability === "support-assistant" ? "info" : "secondary"}>{trace.capability}</Badge>
              )}
              {trace.backendId && <Badge variant="outline" className="font-mono">{trace.backendId}</Badge>}
              {trace.modelId && <Badge variant="outline" className="font-mono text-[10px]">{trace.modelId}</Badge>}
              {trace.keyLabel && <Badge variant="secondary">{trace.keyLabel}</Badge>}
              {trace.intent && <Badge variant="success">{trace.intent}</Badge>}
              {trace.fallbackTriggered && <Badge variant="warning">fallback fired</Badge>}
            </div>

            {/* the turn */}
            <div className="space-y-3">
              <Bubble role="user">{trace.question ?? "(not recorded)"}</Bubble>
              {trace.answer != null && trace.answer.length > 0 ? (
                <Bubble role="assistant">{trace.answer}</Bubble>
              ) : trace.error ? (
                <Bubble role="assistant" tone="error">{trace.error}</Bubble>
              ) : (
                <Bubble role="assistant" tone="warning">(no answer recorded — refused or failed before generation)</Bubble>
              )}
            </div>

            {/* retrieval trace */}
            {trace.retrieval && trace.retrieval.length > 0 && (
              <div className="rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  retrieved {trace.retrieval.length} entries
                  {trace.retrievalConfidence !== null && trace.retrievalConfidence !== undefined
                    ? ` · confidence ${trace.retrievalConfidence.toFixed(2)}`
                    : ""}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {trace.retrieval.map((e) => (
                    <li key={e.id} className="truncate text-xs text-muted-foreground">
                      <Badge variant="outline" className="mr-1.5 text-[10px]">{e.intent}</Badge>
                      {e.question.slice(0, 70)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* routing plan */}
            {trace.plan && trace.plan.length > 0 && (
              <div className="rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground">routing plan</p>
                <ol className="mt-2 space-y-1">
                  {trace.plan.map((s, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs">
                      <Badge variant={outcomeBadge(s.action)}>{s.action}</Badge>
                      <span className="font-mono">{s.backendId}</span>
                      <span className="text-muted-foreground">{s.reason}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* metering */}
            {(trace.tokens !== undefined || trace.costUsd !== undefined || trace.latencyMs !== undefined) && (
              <div className="grid grid-cols-4 gap-2 rounded-lg border p-3">
                <div>
                  <p className="text-[10px] text-muted-foreground">tokens</p>
                  <p className="font-mono text-sm font-semibold">{trace.tokens ?? 0}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">cost</p>
                  <p className="font-mono text-sm font-semibold">{usd(trace.costUsd ?? 0)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">latency</p>
                  <p className="font-mono text-sm font-semibold">{trace.latencyMs ?? 0} ms</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">request</p>
                  <p className="font-mono text-sm font-semibold">{trace.id.slice(0, 8)}</p>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}