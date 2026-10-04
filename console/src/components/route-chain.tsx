import { CircleMinus, CircleSlash, CircleX, CircleCheck } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import { outcomeBadge } from "../lib/badges";

/**
 * The routing chain, wherever a turn is inspected (playground X-ray, trace
 * dialog): every backend in the plan, in call order, with what actually
 * happened to it — answered, tried-and-failed, abandoned, or never called.
 *
 * The plan is the whole candidate list now: the gateway records the tail the
 * winner made unreachable as `skipped` steps, so the chain makes visible that
 * a backend answering first was the policy pick, not a fallback — the exact
 * confusion behind a tier-b trace reading "fallback idle".
 */

export type RouteStep = { backendId: string; action: string; reason: string };

/** Icon per action — the shape of "what happened", not just its name. */
const ACTION_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  served: CircleCheck,
  failed: CircleX,
  abandoned: CircleSlash,
  skipped: CircleMinus,
  blocked_policy: CircleSlash,
};

export function RouteChain({ plan }: { plan: RouteStep[] | null | undefined }): React.ReactElement {
  if (!plan?.length) return <p className="text-sm text-muted-foreground">no routing plan recorded</p>;
  return (
    <ol className="min-w-0 space-y-0">
      {plan.map((s, i) => {
        const Icon = ACTION_ICON[s.action] ?? CircleMinus;
        const isLast = i === plan.length - 1;
        return (
          <li key={i} className="flex min-w-0 gap-2">
            {/* connector column: status icon, then a line down to the next hop */}
            <div className="flex flex-col items-center pt-1.5">
              <Icon className={cn("size-3.5 shrink-0", outcomeIcon(s.action))} />
              {!isLast && <span className="h-3 w-px bg-border" />}
            </div>
            <div className={cn("min-w-0", isLast ? "pb-0" : "pb-3")}>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-xs" title={s.backendId}>{s.backendId}</span>
                <Badge variant={outcomeBadge(s.action)} className="text-[10px]">{s.action}</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">{s.reason}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function outcomeIcon(action: string): string {
  switch (action) {
    case "served": return "text-emerald-500";
    case "failed": return "text-destructive";
    case "abandoned": return "text-destructive";
    case "blocked_policy": return "text-amber-500";
    default: return "text-muted-foreground/50"; // skipped: planned, never called
  }
}