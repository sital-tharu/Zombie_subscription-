/**
 * Foreign money, converted by hand.
 *
 * A receipt email can be denominated in anything -- an Anthropic bill arrives in
 * USD -- and until this file existed the currency was dropped at the Zod
 * boundary: "$20.00" became `total: 20`, was stored, and rendered as "₹20". No
 * error, no warning, a twentieth of the real figure sitting inside a rupee
 * total.
 *
 * Two rules hold the fix together:
 *
 *   1. The NATIVE amount is the source of truth. `total` is never overwritten
 *      with a converted figure; conversion is derived at read time, every time,
 *      from a rate the user typed in. So changing the rate re-prices history
 *      instead of leaving a fossilised number behind.
 *
 *   2. No rate means no claim. A currency with nothing configured for it is
 *      EXCLUDED from every total rather than counted at face value, which is
 *      what "20" would silently be. This mirrors the Evidence Gap Handler: the
 *      app would rather show a row it cannot price than a price it cannot
 *      support.
 *
 * The rates live in the environment because they are entered by hand and go
 * stale. That is a real trade -- `GEMINI_MODEL` is a code constant precisely so
 * a deployment cannot disagree with a laptop, and rates in env can. Rule 2 is
 * what keeps that trade safe: a Vercel deploy that forgets FX_RATES shows
 * "not counted", not a wrong number.
 *
 * Nothing here is reachable from Layers 1-3. The engine still receives plain
 * rupees, so `TransactionLike` is unchanged and the purity boundary holds.
 */
import { round2 } from "./dates";
import type { StoredTransaction, TransactionLike } from "./types";

/** Everything the engine counts is denominated in this. */
export const HOME_CURRENCY = "INR";

/**
 * Parse `FX_RATES`, e.g. "USD:87.4,EUR:95.2".
 *
 * Malformed entries are dropped rather than defaulted. A typo'd rate that
 * quietly became 1.0 would convert $20 to ₹20 -- reintroducing the exact bug
 * this file exists to fix, with the added insult of looking deliberate.
 */
export function parseRates(raw: string | undefined): Map<string, number> {
  const rates = new Map<string, number>();
  if (!raw) return rates;

  for (const entry of raw.split(",")) {
    const [code, value] = entry.split(":");
    if (code === undefined || value === undefined) continue;

    const currency = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;

    const rate = Number(value.trim());
    if (!Number.isFinite(rate) || rate <= 0) continue;

    rates.set(currency, rate);
  }
  return rates;
}

/** The rates as configured for this process. App code only -- tests pass their own. */
export function configuredRates(): Map<string, number> {
  return parseRates(process.env.FX_RATES);
}

/** Display-only provenance for the rate, e.g. "2026-08-08". */
export function ratesAsOf(): string | null {
  const value = process.env.FX_RATES_AS_OF?.trim();
  return value ? value : null;
}

/**
 * A row's currency, defaulting to rupees.
 *
 * Every row written before this field existed is genuinely INR -- the seed, and
 * every GPay screenshot, which is a rupee-only surface. Defaulting is therefore
 * correct rather than merely convenient, and it is what keeps EXPECTED_SEED_OUTCOME
 * from moving.
 */
export function currencyOf(txn: { currency?: string }): string {
  const code = txn.currency?.trim().toUpperCase();
  return code ? code : HOME_CURRENCY;
}

/** Rupees for a native amount, or null when no rate is configured. */
export function toRupees(
  amount: number,
  currency: string,
  rates: ReadonlyMap<string, number>,
): number | null {
  const code = currency.trim().toUpperCase();
  if (code === HOME_CURRENCY) return amount;

  const rate = rates.get(code);
  if (rate === undefined) return null;

  return round2(amount * rate);
}

/** What a converted row was, before conversion. Lets the UI show its working. */
export interface Conversion {
  native: number;
  currency: string;
  rate: number;
  rupees: number;
}

export interface EngineRows {
  /** INR only. Safe to hand to `analyze()`. */
  rows: TransactionLike[];
  /** By transaction id, for the rows that needed converting. */
  converted: Map<string, Conversion>;
  /** Had a foreign currency and no rate. Counted nowhere; shown anyway. */
  excluded: StoredTransaction[];
}

/**
 * Split stored rows into what the engine may count and what it must not.
 *
 * Called by every `analyze()` caller BEFORE the engine sees anything, which is
 * what lets Layers 1-3 stay rupee-only and untouched by this feature.
 *
 * A single flat rate per currency is deliberate over per-date historical rates.
 * Layer 1 chains charges whose amounts are within ±10% of each other, and a
 * moving rate makes a steady $20/month wobble in rupees -- enough drift over a
 * year to break the chain and lose the subscription entirely. A flat rate
 * converts every cycle identically, so detection behaves exactly as it does for
 * a rupee subscription.
 */
export function toEngineRows(
  txns: readonly StoredTransaction[],
  rates: ReadonlyMap<string, number>,
): EngineRows {
  const rows: TransactionLike[] = [];
  const converted = new Map<string, Conversion>();
  const excluded: StoredTransaction[] = [];

  for (const txn of txns) {
    const currency = currencyOf(txn);

    if (currency === HOME_CURRENCY) {
      rows.push(txn);
      continue;
    }

    const rupees = toRupees(txn.total, currency, rates);
    if (rupees === null) {
      excluded.push(txn);
      continue;
    }

    // A new object rather than a mutation: the stored row keeps its native
    // amount, and the UI reads both from the same source.
    rows.push({ id: txn.id, merchant: txn.merchant, date: txn.date, total: rupees });
    converted.set(txn.id, {
      native: txn.total,
      currency,
      rate: rates.get(currency)!,
      rupees,
    });
  }

  return { rows, converted, excluded };
}
