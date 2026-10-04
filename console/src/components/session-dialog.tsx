import { useEffect, useState } from "react";
import { Badge } from "./ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { outcomeBadge } from "../lib/badges";
import { usd } from "../lib/utils";
import { fetchSessionTimeline, type Turn } from "../api";
import { Bubble, Markdown } from "../lib/chatui";

/**
 * Session timeline (Langfuse session view): turns in order, full trace on
 * each. Both the observability home and the see-all session pages open it.
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{timeline ? timeline.title : "session"}</DialogTitle>
        </DialogHeader>
        {timeline === null ? (
          <p className="text-sm text-muted-foreground">loading…</p>
        ) : (
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
            {timeline.turns.map((t) => (
              <div key={t.id} className="rounded-lg border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">{t.createdAt.slice(11, 19)} UTC</span>
                  <Badge variant={outcomeBadge(t.outcome)}>{t.outcome}</Badge>
                  {t.intent && <Badge variant="success">{t.intent}</Badge>}
                  <Badge variant="outline" className="font-mono text-[10px]">{t.backendId} · {t.modelId.split("/").pop()}</Badge>
                  <Badge variant="secondary" className="text-[10px]">{t.keyLabel ?? "—"}</Badge>
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
        )}
      </DialogContent>
    </Dialog>
  );
}