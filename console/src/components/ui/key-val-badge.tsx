import { cn } from "../../lib/utils";
import { badgeVariants, type BadgeProps } from "./badge";

/**
 * A pill that names its value — "status: refused" instead of a bare
 * "refused" — so metadata reads as key-value pairs, not dangling tokens.
 * The label drops to muted so the value still reads as the payload; colors
 * come from the shared badge palette (design.md: same status renders
 * identically everywhere).
 */
type KeyValBadgeVariant = NonNullable<BadgeProps["variant"]>;

export type KeyValBadgeProps = {
  label: string;
  value: string;
  variant?: KeyValBadgeVariant;
  /** Hover text for values that truncate (ids, model strings). */
  title?: string;
  className?: string;
};

export function KeyValBadge({ label, value, variant = "secondary", title, className }: KeyValBadgeProps): React.ReactElement {
  return (
    <span
      title={title}
      className={cn(badgeVariants({ variant }), "font-mono text-[11px]", className)}
    >
      <span className="font-sans font-normal opacity-60">{label}:</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}