import { cn } from "./utils";

/** Chat bubbles shared by the playground and the trace/session viewers. */

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