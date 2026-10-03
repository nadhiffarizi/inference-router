import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 6 : 2)}`;