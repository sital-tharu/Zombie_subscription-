/**
 * Remove the scripted demo history, leaving real transactions untouched:
 *   npm run wipe:seed
 *
 * Dogfooding and demoing need the same store but not the same data. Mixing them
 * sums a synthetic ₹2,893 with real spending into one meaningless total, so the
 * two datasets stay switchable:
 *
 *   npm run seed        demo history -> ₹2,893 / ₹5,988
 *   npm run wipe:seed   only your real transactions
 *   npm run seed        demo history back
 *
 * Only rows carrying `seeded: true` are removed. Anything ingested from a
 * screenshot survives, which is the whole point.
 */
import "./load-env";
import { analyze } from "../src/lib/correlate";
import { getStore } from "../src/lib/store";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

async function main(): Promise<void> {
  const store = await getStore();
  const before = await store.listTransactions(5000);
  const seeded = before.filter((t) => t.seeded).length;
  const real = before.length - seeded;

  console.log(`Store: ${store.mode}`);
  console.log(`Before: ${before.length} transactions — ${seeded} seeded, ${real} real\n`);

  if (seeded === 0) {
    console.log("Nothing seeded to remove.");
  } else {
    await store.replaceSeeded([]);
    console.log(`Removed ${seeded} seeded transactions.`);
  }

  const after = await store.listTransactions(5000);
  console.log(`After: ${after.length} transactions — all real.\n`);

  if (after.length === 0) {
    console.log("The store is now empty. The dashboard will show its empty state.");
    console.log("Run `npm run ingest` to load screenshots, or `npm run seed` to restore the demo.");
    return;
  }

  // What the dashboard will now show. With real data this is the dogfooding
  // result; with too little history it is legitimately nothing, because
  // detection needs three charges of the same merchant 25-35 days apart.
  const answers = await store.listAnswers();
  const result = analyze(after, undefined, { answers });

  console.log(`Analysing ${after.length} real transactions as of ${result.asOf}:\n`);
  if (result.subscriptions.length === 0) {
    console.log("  No recurring charges detected.");
    console.log("  Detection needs 3+ charges of the same merchant, 25-35 days apart —");
    console.log("  so this usually means the history is too short, not that nothing recurs.");
    return;
  }

  for (const v of result.verdicts) {
    const money = v.zombieScore > 0 ? inr(v.zombieScore) : v.potentialWaste > 0 ? `(${inr(v.potentialWaste)} at risk)` : "-";
    console.log(`  ${v.merchant.padEnd(24)} ${v.verdict.padEnd(14)} ${v.confidence.padEnd(15)} ${money}`);
  }
  console.log(`\n  Total wasted   : ${inr(result.totalWasted)}`);
  console.log(`  Annual savings : ${inr(result.annualSavings)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
