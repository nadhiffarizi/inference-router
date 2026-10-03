import { cn } from "../../lib/utils";

function Separator({ className, vertical = false }: { className?: string; vertical?: boolean }): React.ReactElement {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn("shrink-0 bg-border", vertical ? "w-px self-stretch" : "h-px w-full", className)}
    />
  );
}

export { Separator };