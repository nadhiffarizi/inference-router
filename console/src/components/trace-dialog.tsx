import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { TraceContent } from "./trace-content";

/**
 * The trace viewer as a centered dialog — how the playground and the
 * /observability home open a turn. The see-all pages open the same body in a
 * right drawer instead (trace-drawers.tsx).
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
      <DialogContent className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-4 overflow-hidden">
        {trace && (
          <>
            {/* mb-0: the flex gap covers the header's spacing */}
            <DialogHeader className="mb-0 shrink-0">
              <DialogTitle>trace · {trace.createdAt.slice(0, 19).replace("T", " ")} UTC</DialogTitle>
            </DialogHeader>

            <TraceContent trace={trace} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}