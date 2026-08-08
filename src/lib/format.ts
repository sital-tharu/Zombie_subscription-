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

/**
 * A native foreign amount, e.g. "$20.00".
 *
 * Separate from `inr()` rather than a generalisation of it, deliberately: `inr`
 * is called on every figure the engine produces, and those are rupees by
 * definition. Widening it would invite a currency argument at hundreds of call
 * sites where the answer is always the same, and one wrong argument would
 * mislabel a real figure. This one is only ever called on a row that genuinely
 * carries a foreign currency.
 *
 * Falls back to "CODE amount" for anything Intl does not recognise, which is
 * better than throwing inside a render.
 */
export function money(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: code,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
}

/**
 * "22 Aug" -- the year dropped. Only for the projected next charge, which is
 * always within about a month, where the year is noise in a scannable column.
 */
export function dayMonth(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/** "August 2026". Accepts a full ISO date or a bare "YYYY-MM" month key. */
export function monthLabel(iso: string): string {
  const [y, m] = iso.split("-");
  return `${MONTHS_FULL[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Month keys, for the ‹ › navigator.
//
// "YYYY-MM" strings rather than Date objects, so every comparison is a string
// comparison and nothing can drift by a timezone. The engine's own dates are
// ISO strings for the same reason.
// ---------------------------------------------------------------------------

/** "2026-08-04" -> "2026-08". */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** "2026-08" -> "2026-08-01". */
export function firstDayOfMonth(key: string): string {
  return `${key}-01`;
}

/** "2026-08" -> "2026-08-31". Handles February and leap years via day 0 rollover. */
export function lastDayOfMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  // Day 0 of the NEXT month is the last day of this one.
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${key}-${String(day).padStart(2, "0")}`;
}

/** Step a month key by `delta` months, wrapping the year. */
export function addMonths(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** True when `key` is a well-formed "YYYY-MM". */
export function isMonthKey(key: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(key)) return false;
  const month = Number(key.slice(5));
  return month >= 1 && month <= 12;
}

/**
 * Where a transaction came from, as a word.
 *
 * `seeded` is checked before `source` because a seeded row also carries
 * source: "seed" -- but a row seeded by an older script version might not, and
 * showing scripted demo data as though it were a real receipt is exactly the
 * claim this badge exists to prevent.
 */
/**
 * Colours for a provenance badge.
 *
 * Kept apart from `verdictTheme` on purpose: red, green and amber already carry
 * meaning about usage, and reusing them for where a charge came from would put
 * two different claims in the same colour on the same row.
 */
export function sourceTheme(label: string): { text: string; bg: string } {
  switch (label) {
    case "Receipt":
      return {
        text: "text-[var(--color-src-receipt)]",
        bg: "bg-[var(--color-src-receipt-bg)]",
      };
    case "Email":
      return {
        text: "text-[var(--color-src-email)]",
        bg: "bg-[var(--color-src-email-bg)]",
      };
    default:
      // Demo, Manual and Unknown all read as "not from a document you gave us".
      return {
        text: "text-[var(--color-src-demo)]",
        bg: "bg-[var(--color-src-demo-bg)]",
      };
  }
}

export function sourceLabel(source: string | undefined, seeded?: boolean): string {
  if (seeded || source === "seed") return "Demo";
  switch (source) {
    case "email":
      return "Email";
    case "photo":
      return "Receipt";
    case "manual":
      return "Manual";
    default:
      return "Unknown";
  }
}

/**
 * A verdict as a single character, for the scan column.
 *
 * Never the only carrier of the verdict: colour, and the word beside the money
 * figure, both say the same thing. A glyph alone would fail anyone reading in
 * greyscale or with a screen reader.
 */
export function verdictGlyph(verdict: Verdict): string {
  switch (verdict) {
    case "likely-unused":
      return "✕";
    case "used":
      return "✓";
    case "unknown":
      return "?";
  }
}

/**
 * Days as an approximate month count, for spans measured in months rather than
 * days. Display only: the day count is computed in the engine, and this never
 * feeds a currency figure.
 */
export function monthsLabel(days: number): string {
  if (days < 45) return `${days} days`;
  const months = Math.round(days / 30.44);
  return `${months} month${months === 1 ? "" : "s"}`;
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
