import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { fetchSessionTimeline, type Turn } from "../api";
import { SessionContent } from "./session-content";

/**
 * Session timeline as a centered dialog — how the /observability home opens a
 * session. The see-all pages open the same body in a right drawer instead
 * (trace-drawers.tsx).
 */

export function SessionDialog({ uid, onClose }: { uid: number | null; onClose: () => void }): React.ReactElement {
  const [timeline, setTimeline] = useState<{ title: string; turns: Turn[] } | null>(null);

  useEffect(() => {
    let alive = true;
    setTimeline(null);
    if (uid === null) return;
    fetchSessionTimeline(uid, true).then((t) => {
      if (!alive || !t) return;
      setTimeline({ title: t.session.title, turns: t.turns });
    });
    return () => {
      alive = false;
    };
  }, [uid]);

  return (
    <Dialog open={uid !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden">
        <DialogHeader className="mb-0 shrink-0">
          <DialogTitle>{timeline ? timeline.title : "session"}</DialogTitle>
        </DialogHeader>
        {timeline === null ? (
          <p className="pt-3 text-sm text-muted-foreground">loading…</p>
        ) : (
          <SessionContent turns={timeline.turns} />
        )}
      </DialogContent>
    </Dialog>
  );
}