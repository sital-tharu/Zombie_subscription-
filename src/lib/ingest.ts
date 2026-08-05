/**
 * The two write operations, shared by the server actions the dashboard calls
 * and the HTTP routes an external caller would use. One implementation, two
 * entry points -- so the API and the UI can never drift into disagreeing about
 * what an answer means.
 */
import { randomUUID } from "node:crypto";
import { todayIso } from "./dates";
import { extractTransactions } from "./extract";
import { merchantKeyOf } from "./merchant-map";
import { getStore } from "./store";
import type { StoredTransaction, UserAnswer } from "./types";

export async function recordAnswer(
  merchantKey: string,
  used: boolean,
): Promise<UserAnswer> {
  const answer: UserAnswer = {
    merchantKey,
    used,
    answeredAt: new Date().toISOString(),
  };
  const store = await getStore();
  await store.saveAnswer(answer);
  return answer;
}

/**
 * Discard a stored answer so the engine's own inference applies again.
 *
 * The alternative -- letting a user only ever flip between yes and no -- makes a
 * mis-tap permanent, and a mistaken "no" prices an entire charge chain as waste.
 * A verdict the user can reach but not leave is worse than one they cannot
 * reach at all.
 */
export async function forgetAnswer(merchantKey: string): Promise<void> {
  const store = await getStore();
  await store.clearAnswer(merchantKey);
}

/**
 * Record that the user has cancelled these, as of today.
 *
 * Dated rather than a bare flag: the date is what the engine compares charges
 * against, so a subscription that keeps billing afterwards is caught instead of
 * quietly disappearing from the run rate.
 */
export async function recordCancellations(merchantKeys: readonly string[]): Promise<void> {
  const store = await getStore();
  const cancelledAt = todayIso();
  for (const merchantKey of merchantKeys) {
    await store.saveCancellation({ merchantKey, cancelledAt });
  }
}

/** Undo a declared cancellation, e.g. the user did not get round to it. */
export async function forgetCancellation(merchantKey: string): Promise<void> {
  const store = await getStore();
  await store.clearCancellation(merchantKey);
}

export interface IngestResult {
  added: number;
  transactions: StoredTransaction[];
}

export async function ingestScreenshot(
  bytes: Buffer,
  mimeType: string,
): Promise<IngestResult> {
  const extracted = await extractTransactions({ bytes, mimeType });

  const batch = randomUUID().slice(0, 8);
  const transactions: StoredTransaction[] = extracted.map((txn, index) => ({
    // The merchant key is baked into the id so a duplicated upload of the same
    // screenshot is visible in the data rather than only in the totals.
    id: `up-${batch}-${merchantKeyOf(txn.merchant)}-${index + 1}`,
    merchant: txn.merchant,
    date: txn.date,
    total: txn.total,
    category: txn.category,
    source: "photo",
    createdAt: new Date().toISOString(),
  }));

  const store = await getStore();
  const added = await store.addTransactions(transactions);
  return { added, transactions };
}
