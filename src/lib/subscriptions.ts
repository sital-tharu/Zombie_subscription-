/**
 * Layer 1: recurring-charge detection.
 *
 * Same merchant, 25-35 day cadence, amount within +/-10%, three or more
 * occurrences. This is table stakes -- every bank app does it -- and it is not
 * the product. It exists here only because scoring needs the full charge chain,
 * with per-charge traceability, which no off-the-shelf tracker exposes.
 */
import { addDaysIso, daysBetween, isIsoDate, median, round2, todayIso } from "./dates";
import { displayNameOf, merchantKeyOf } from "./merchant-map";
import type { ChargeRef, Subscription, TransactionLike } from "./types";

/** Gaps of 25-35 days count as monthly. */
export const CADENCE_DAYS = 30;
export const CADENCE_TOLERANCE_DAYS = 5;
/** +/-10% absorbs ordinary price hikes without chaining unrelated purchases. */
export const AMOUNT_TOLERANCE = 0.1;
export const MIN_OCCURRENCES = 3;

/**
 * How long a chain can go unbilled before we treat it as already cancelled.
 *
 * Deliberately MORE forgiving than the 35-day chain-break rule: one full
 * tolerance band past the date the next charge was due. Billing dates slip, and
 * calling a live subscription "cancelled" is a worse error than being slow to
 * notice a real one -- this figure gates annual savings, and understating what
 * a user could save is safer than inventing savings they cannot make.
 */
export const ENDED_AFTER_DAYS = CADENCE_DAYS + 2 * CADENCE_TOLERANCE_DAYS;

/**
 * Rows the engine will not reason about. Rejected rather than coerced: a
 * transaction with a malformed date or a zero total is a data-quality problem,
 * and silently repairing it would put a guess underneath a currency figure.
 */
export function isUsableTransaction(txn: TransactionLike): boolean {
  return (
    typeof txn.id === "string" &&
    txn.id !== "" &&
    typeof txn.merchant === "string" &&
    txn.merchant.trim() !== "" &&
    isIsoDate(txn.date) &&
    Number.isFinite(txn.total) &&
    txn.total > 0
  );
}

/**
 * Resolve and validate the analysis date.
 *
 * Throws on a malformed `asOf` rather than falling back to today. A silent
 * fallback turns a deterministic test into one that passes for the wrong reason
 * and fails on some future Tuesday.
 */
export function resolveAsOf(asOf?: string): string {
  if (asOf === undefined) return todayIso();
  if (!isIsoDate(asOf)) {
    throw new Error(`analyze(): asOf must be YYYY-MM-DD, received "${asOf}"`);
  }
  return asOf;
}

/**
 * Everything dated on or before `asOf`, dropping unusable rows.
 *
 * The horizon makes `analyze(data, "2026-06-01")` a genuine time machine -- the
 * demo can be replayed as of an earlier date and give the historically correct
 * answer -- and it protects against a future-dated row from an OCR misread
 * quietly extending a charge chain.
 */
export function withinHorizon(
  txns: readonly TransactionLike[],
  asOf: string,
): TransactionLike[] {
  return txns.filter((t) => isUsableTransaction(t) && t.date <= asOf);
}

/**
 * Newest first, with `id` as a tie-break.
 *
 * The tie-break is not cosmetic. The donor's comparator returned 1 for equal
 * dates, which claims both `a > b` and `b > a`; sort behaviour for same-day
 * charges was then implementation-defined. `chargeIds` has to be reproducible,
 * because the evidence chain quotes it and tests assert on it.
 */
function byDateDesc(a: TransactionLike, b: TransactionLike): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

function toChargeRef(txn: TransactionLike): ChargeRef {
  return { id: txn.id, date: txn.date, amount: txn.total };
}

/**
 * Walk backwards from the most recent charge, skipping extra same-month
 * purchases, and keep the current unbroken streak.
 *
 * Grouping is by `merchantKeyOf`, not by the raw payee string. Real GPay names
 * drift between billing cycles ("AMAZON PRIME" -> "Amazon Prime*IN"), and
 * grouping on the raw string splits one seven-charge chain into two three-charge
 * chains -- two Prime cards on screen, each with half the money.
 */
export function detectSubscriptions(
  txns: readonly TransactionLike[],
  asOf?: string,
): Subscription[] {
  const asOfDate = resolveAsOf(asOf);
  const usable = withinHorizon(txns, asOfDate);

  const byMerchant = new Map<string, TransactionLike[]>();
  for (const txn of usable) {
    const key = merchantKeyOf(txn.merchant);
    const group = byMerchant.get(key);
    if (group) group.push(txn);
    else byMerchant.set(key, [txn]);
  }

  const subscriptions: Subscription[] = [];

  for (const [merchantKey, group] of byMerchant) {
    if (group.length < MIN_OCCURRENCES) continue;
    group.sort(byDateDesc);

    const latest = group[0];
    let anchor = latest;
    const chain: TransactionLike[] = [latest];

    for (const txn of group.slice(1)) {
      const gap = daysBetween(txn.date, anchor.date);
      // An extra purchase inside the same billing month -- skip it, don't break.
      if (gap < CADENCE_DAYS - CADENCE_TOLERANCE_DAYS) continue;
      // Cadence broken: keep only the current streak, not the whole history.
      if (gap > CADENCE_DAYS + CADENCE_TOLERANCE_DAYS) break;
      // Tolerance is measured per step against the anchor, not against the
      // first charge, so slow legitimate drift (299 -> 328 -> 361) still chains.
      if (Math.abs(txn.total - anchor.total) / anchor.total > AMOUNT_TOLERANCE) break;
      chain.push(txn);
      anchor = txn;
    }

    if (chain.length < MIN_OCCURRENCES) continue;

    // Ascending from here on. This is what makes "charges after the last usage"
    // a contiguous tail slice rather than an arbitrary filter -- see correlate.ts.
    chain.reverse();
    const charges = chain.map(toChargeRef);
    const gaps: number[] = [];
    for (let i = 1; i < charges.length; i++) {
      gaps.push(daysBetween(charges[i - 1].date, charges[i].date));
    }

    subscriptions.push({
      merchantKey,
      merchant: displayNameOf(latest.merchant),
      // The most recent amount, so a price hike flows through to annual savings.
      monthlyAmount: latest.total,
      occurrences: charges.length,
      firstDate: charges[0].date,
      lastDate: charges[charges.length - 1].date,
      // Chain members only. Summing the whole merchant group would double the
      // money on screen after a re-seed that didn't wipe first.
      totalPaid: round2(charges.reduce((sum, c) => sum + c.amount, 0)),
      chargeIds: charges.map((c) => c.id),
      charges,
      cadenceDays: Math.round(median(gaps)),
      daysSinceLastCharge: daysBetween(charges[charges.length - 1].date, asOfDate),
      spanDays: daysBetween(charges[0].date, charges[charges.length - 1].date),
    });
  }

  // Deterministic order, with merchantKey as a total tie-break. The meaningful
  // ranking is by zombieScore and happens in correlate.ts.
  return subscriptions.sort(
    (a, b) =>
      b.monthlyAmount - a.monthlyAmount ||
      (a.merchantKey < b.merchantKey ? -1 : a.merchantKey > b.merchantKey ? 1 : 0),
  );
}

/** Combined monthly cost of every detected subscription. */
export function monthlyTotal(subs: readonly Subscription[]): number {
  return round2(subs.reduce((sum, s) => sum + s.monthlyAmount, 0));
}

/**
 * Has this chain stopped billing?
 *
 * A cancelled subscription still forms a valid chain -- detection walks back
 * from the latest charge, and does not care that the latest charge was in
 * March. Without this check such a chain is flagged unused and contributes a
 * full year of "savings" on money the user already stopped spending.
 */
export function hasEnded(sub: Subscription): boolean {
  return sub.daysSinceLastCharge > ENDED_AFTER_DAYS;
}

/** Projected date of the next charge, for "next billing in ~13 days". */
export function nextChargeDate(sub: Subscription): string {
  return addDaysIso(sub.lastDate, sub.cadenceDays || CADENCE_DAYS);
}
