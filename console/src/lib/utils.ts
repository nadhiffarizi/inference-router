import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Sub-dollar precision matters here: per-request cost is ~1e-4..1e-5 USD and
 * the daily budget is small ($0.70), so "remaining" only moves in the 4th
 * decimal — 2-decimal formatting would freeze it at $0.70 all day.
 */
export const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 6 : n < 1 ? 4 : 2)}`;