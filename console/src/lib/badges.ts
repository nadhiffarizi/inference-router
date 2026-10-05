import type { BadgeProps } from "../components/ui/badge";

/**
 * The one mapping from domain status to badge variant, per design.md: "same
 * status must render identically everywhere" — the playground, usage view,
 * and decision log all read from here rather than re-deciding colors.
 */

export type BadgeVariant = NonNullable<BadgeProps["variant"]>;

export const OUTCOME_BADGES: Record<string, BadgeVariant> = {
  ok: "success",
  served: "success",
  refused: "warning",
  blocked_policy: "warning",
  failed: "destructive",
  error: "destructive",
  abandoned: "destructive",
  skipped: "secondary",
};

export function outcomeBadge(outcome: string | undefined | null): BadgeVariant {
  return (outcome && OUTCOME_BADGES[outcome]) || "secondary";
}