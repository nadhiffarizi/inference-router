import { Badge } from "./ui/badge";
import { RouteChain } from "./route-chain";
import { outcomeBadge } from "../lib/badges";
import { NO_ANSWER_TEXT } from "../lib/copy";
import { usd } from "../lib/utils";
import { Bubble, Markdown } from "../lib/chatui";
import type { TracePayload } from "./trace-dialog";

/**
 * The one trace view's body — question, answer, what was retrieved, how it was
 * routed, what it cost — without a surface of its own. The dialog (playground,
 * /observability home) and the right drawer (see-all pages) both render this,
 * so a turn looks identical wherever it opens.
 */

export function TraceContent({ trace }: { trace: TracePayload }): React.ReactElement {
  return (
    <>
      {/* summary badges — the run's verdict first, the routing details after the divider */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b pb-3">
        {trace.outcome && <Badge variant={outcomeBadge(trace.outcome)}>{trace.outcome}</Badge>}
        {trace.fallbackTriggered && <Badge variant="warning">fallback fired</Badge>}
        {trace.outcome && <span className="text-border" aria-hidden>|</span>}
        {trace.capability && (
          <Badge variant={trace.capability === "support-assistant" ? "info" : "secondary"}>{trace.capability}</Badge>
        )}
        {trace.intent && <Badge variant="success">{trace.intent}</Badge>}
        {trace.keyLabel && <Badge variant="secondary">{trace.keyLabel}</Badge>}
        {trace.backendId && <Badge variant="outline" className="font-mono">{trace.backendId}</Badge>}
        {trace.modelId && <Badge variant="outline" className="font-mono text-[10px]">{trace.modelId}</Badge>}
      </div>

      {/* the middle: turn, retrieval and routing share one scroll area, so the
          surface never grows past its header + metering fixed rows */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {/* the turn */}
        <div className="space-y-3">
          <Bubble role="user">{trace.question ?? "(not recorded)"}</Bubble>
          {trace.answer != null && trace.answer.length > 0 ? (
            <Bubble role="assistant"><Markdown text={trace.answer} /></Bubble>
          ) : trace.error ? (
            <Bubble role="assistant" tone="error">{trace.error}</Bubble>
          ) : (
            <Bubble role="assistant" tone="warning">{NO_ANSWER_TEXT}</Bubble>
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

        {/* routing plan — the chain, not just the winner */}
        {trace.plan && trace.plan.length > 0 && (
          <div className="rounded-lg border p-3">
            <p className="text-xs font-medium text-muted-foreground">routing plan</p>
            <div className="mt-2">
              <RouteChain plan={trace.plan} />
            </div>
          </div>
        )}
      </div>

      {/* metering — pinned to the surface's bottom edge */}
      {(trace.tokens !== undefined || trace.costUsd !== undefined || trace.latencyMs !== undefined) && (
        <div className="grid shrink-0 grid-cols-5 gap-2 rounded-lg border p-3">
          <div>
            <p className="text-[10px] text-muted-foreground">tokens</p>
            <p className="font-mono text-sm font-semibold">{trace.tokens ?? 0}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">cost</p>
            <p className="font-mono text-sm font-semibold">{usd(trace.costUsd ?? 0)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">first token</p>
            <p className="font-mono text-sm font-semibold">{trace.ttftMs ?? "—"}</p>
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
  );
}