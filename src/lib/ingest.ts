/**
 * The two write operations, shared by the server actions the dashboard calls
 * and the HTTP routes an external caller would use. One implementation, two
 * entry points -- so the API and the UI can never drift into disagreeing about
 * what an answer means.
 */
import { randomUUID } from "node:crypto";
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
