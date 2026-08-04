/**
 * Display formatting. UI-only -- no engine module imports this, and nothing
 * here rounds or derives a figure. Formatting is the last thing that happens to
 * a number, never the place one is decided.
 */
import type { Confidence, Verdict } from "./types";

/** Indian digit grouping: 2,093 but 1,23,456. */
export function inr(amount: number): string {
  const whole = Number.isInteger(amount);
  return `₹${amount.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(d)} ${months[Number(m) - 1]} ${y.slice(2)}`;
}

export function daysAgoLabel(days: number | null): string {
  if (days === null) return "never";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Confidence as a word. Never a percentage -- a fake precision number would
 * undercut the honesty the whole product is arguing for.
 */
export function confidenceLabel(confidence: Confidence): string {
  switch (confidence) {
    case "high":
      return "High confidence";
    case "medium":
      return "Medium confidence";
    case "low":
      return "Low confidence";
    case "none":
      return "No signal";
    case "user-confirmed":
      return "Confirmed by you";
  }
}

export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "likely-unused":
      return "Likely unused";
    case "used":
      return "Used";
    case "unknown":
      return "Can't tell";
  }
}

interface VerdictTheme {
  text: string;
  border: string;
  chipBg: string;
  dot: string;
}

export function verdictTheme(verdict: Verdict): VerdictTheme {
  switch (verdict) {
    case "likely-unused":
      return {
        text: "text-[var(--color-zombie)]",
        border: "border-l-[var(--color-zombie)]",
        chipBg: "bg-[var(--color-zombie-dim)]",
        dot: "bg-[var(--color-zombie)]",
      };
    case "used":
      return {
        text: "text-[var(--color-alive)]",
        border: "border-l-[var(--color-alive)]",
        chipBg: "bg-[var(--color-alive-dim)]",
        dot: "bg-[var(--color-alive)]",
      };
    case "unknown":
      return {
        text: "text-[var(--color-unsure)]",
        border: "border-l-[var(--color-unsure)]",
        chipBg: "bg-[var(--color-unsure-dim)]",
        dot: "bg-[var(--color-unsure)]",
      };
  }
}
