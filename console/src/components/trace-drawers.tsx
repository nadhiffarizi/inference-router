import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { TraceContent } from "./trace-content";
import { SessionContent } from "./session-content";
import { fetchSessionTimeline, type Turn } from "../api";
import type { TracePayload } from "./trace-dialog";

/**
 * The right-drawer surfaces for the see-all log pages: a row's detail slides
 * in from the right while the table stays visible behind it — reading a trace
 * against the list is the whole point of that page. Same bodies as the dialogs
 * (trace-content / session-content), different surface.
 */

export function TraceSheet({ trace, onClose }: { trace: TracePayload | null; onClose: () => void }): React.ReactElement {
  return (
    <Sheet open={trace !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex h-full flex-col gap-4 overflow-hidden p-6 sm:max-w-xl"
        aria-describedby={undefined}
      >
        {trace && (
          <>
            <SheetHeader className="shrink-0">
              <SheetTitle className="text-base">trace · {trace.createdAt.slice(0, 19).replace("T", " ")} UTC</SheetTitle>
              <SheetDescription className="hidden">{String(trace.id)}</SheetDescription>
            </SheetHeader>
            <TraceContent trace={trace} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function SessionSheet({ uid, onClose }: { uid: number | null; onClose: () => void }): React.ReactElement {
  const [timeline, setTimeline] = useState<{ title: string; externalId: string; turns: Turn[] } | null>(null);

  useEffect(() => {
    let alive = true;
    setTimeline(null);
    if (uid === null) return;
    fetchSessionTimeline(uid, true).then((t) => {
      if (!alive || !t) return;
      setTimeline({ title: t.session.title, externalId: t.session.externalId, turns: t.turns });
    });
    return () => {
      alive = false;
    };
  }, [uid]);

  return (
    <Sheet open={uid !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex h-full flex-col gap-4 overflow-hidden p-6 sm:max-w-xl"
        aria-describedby={undefined}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle className="text-base">{timeline ? timeline.title : "session"}</SheetTitle>
          <SheetDescription className="font-mono text-[10px]">
            {timeline ? `${timeline.externalId} · ${timeline.turns.length} turns` : "loading…"}
          </SheetDescription>
        </SheetHeader>
        {timeline === null ? (
          <p className="text-sm text-muted-foreground">loading…</p>
        ) : (
          <SessionContent turns={timeline.turns} />
        )}
      </SheetContent>
    </Sheet>
  );
}