import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "./utils";

/** Chat bubbles shared by the playground and the trace/session viewers. */

/**
 * Model answers are markdown (models emit **bold** bullets freely), so
 * assistant content renders through GFM. Every element gets an explicit class
 * here — bubble styling stays predictable without the typography plugin.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  if (!text.trim()) return <span />;
  return (
    <div
      className={cn(
        "break-words",
        // paragraphs flow tight inside a bubble
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1.5",
        // lists: real bullets/numbers, no indent creep
        "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:ps-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:ps-5",
        "[&_li]:my-0.5 [&_li]:marker:text-muted-foreground [&_li>p]:my-0",
        // inline + block code
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.8em]",
        "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        // headings, quotes, rules, links, tables
        "[&_h1]:my-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:text-sm [&_h2]:font-semibold",
        "[&_h3]:my-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_blockquote]:my-1.5 [&_blockquote]:border-s-2 [&_blockquote]:border-border [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground",
        "[&_hr]:my-2 [&_a]:text-primary [&_a]:underline [&_table]:my-1.5 [&_table]:w-full [&_table]:text-xs [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-start [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export function Bubble({
  role,
  tone,
  live,
  children,
}: {
  role: "user" | "assistant";
  tone?: "error" | "warning";
  live?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={role === "user" ? "flex justify-end" : "flex justify-start"}>
      <div
        className={cn(
          role === "user" ? "max-w-[85%]" : "max-w-[min(92%,75ch)]",
          "px-3.5 py-2.5 text-sm leading-relaxed",
          role === "user"
            ? "rounded-xl rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-xl rounded-bl-sm border",
          role === "assistant" && tone === "error" && "border-destructive/40 bg-destructive/5 text-destructive",
          role === "assistant" && tone === "warning" && "border-amber-500/40 bg-amber-500/5 text-foreground",
          role === "assistant" && !tone && "bg-card",
          live && "animate-pulse",
        )}
      >
        {children}
      </div>
    </div>
  );
}