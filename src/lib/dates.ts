/**
 * ISO date arithmetic. Imports nothing.
 *
 * Every date in this system is a "YYYY-MM-DD" string, never a Date object.
 * Strings in this format sort lexicographically, which means `a < b` is a valid
 * chronological comparison and no timezone can get between two stored dates.
 *
 * THE TRAP, worth stating once and loudly:
 *
 *   Date.parse("2026-08-04")        -> UTC midnight
 *   new Date().getDate()            -> LOCAL day-of-month
 *
 * So: parse as UTC when taking the DIFFERENCE between two ISO strings (both
 * sides are UTC, so the difference is exact and DST-proof), and read LOCAL
 * fields when asking "what is today". Do it the other way around and todayIso()
 * returns yesterday for the first 5.5 hours of every IST day, which silently
 * slides the 90-day correlation window by one day. The demo is at 3:30 PM IST
 * so it would never bite on stage -- but `npm run test:logic` runs at any hour,
 * and a suite that fails only before sunrise is worse than one that fails.
 */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

/** True for a well-formed, real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  // Rejects "2026-02-31": Date normalises it to March 3, so the round-trip differs.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && toIsoUtc(parsed) === value;
}

/** Today, from LOCAL calendar fields. See the trap note above. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Whole days from `earlier` to `later`. Negative if the arguments are reversed.
 * Both sides parse as UTC midnight, so the result is exact -- no rounding
 * needed, and no DST discontinuity to round across.
 */
export function daysBetween(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / MS_PER_DAY;
}

/** Shift an ISO date by whole days. Negative values move backwards. */
export function addDaysIso(iso: string, days: number): string {
  return toIsoUtc(new Date(Date.parse(iso) + days * MS_PER_DAY));
}

/** Format a Date's UTC fields as YYYY-MM-DD. Internal to this module's arithmetic. */
function toIsoUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Median of a numeric list. Returns 0 for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Round to paise. Applied at every sum, not just the headline.
 *
 * Seeded amounts are whole rupees, but real GPay history has paise, and three
 * charges of 82.60 sum to 247.79999999999998 in float. A savings total that
 * renders as "₹247.8" once and "₹247.79999999999998" elsewhere destroys the
 * auditability claim more effectively than a wrong number would.
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
