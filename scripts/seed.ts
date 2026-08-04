/**
 * Seed the scripted demo history:
 *   npm run seed
 *
 * Writes to Firestore when a service account is configured, and to
 * ./data/zombie.json otherwise. Re-running replaces the previously seeded rows
 * rather than appending, so the numbers cannot drift by seeding twice.
 *
 * Prints the resulting verdicts, so the demo figures are checked at the moment
 * the data is written rather than discovered on screen later.
 */
import "dotenv/config";
import { analyze } from "../src/lib/correlate";
import { buildSeedTransactions, EXPECTED_SEED_OUTCOME } from "../src/lib/seed-data";
import { getStore } from "../src/lib/store";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

async function main(): Promise<void> {
  const store = await getStore();
  const transactions = buildSeedTransactions();

  const written = await store.replaceSeeded(transactions);
  console.log(`Seeded ${written} transactions via the ${store.mode} store.\n`);

  const answers = await store.listAnswers();
  const result = analyze(transactions, undefined, { answers });

  console.log(`As of ${result.asOf}, ${result.lookbackDays}-day lookback:\n`);
  for (const v of result.verdicts) {
    const money = v.zombieScore > 0 ? inr(v.zombieScore) : v.potentialWaste > 0 ? `(${inr(v.potentialWaste)} at risk)` : "-";
    console.log(`  ${v.merchant.padEnd(20)} ${v.verdict.padEnd(14)} ${v.confidence.padEnd(15)} ${money}`);
    console.log(`  ${" ".repeat(20)} ${v.reason}\n`);
  }

  console.log(`  Total wasted to date : ${inr(result.totalWasted)}`);
  console.log(`  Annual savings       : ${inr(result.annualSavings)}`);
  console.log(`  Awaiting your answer : ${result.needsInput.map((v) => v.merchant).join(", ") || "none"}`);

  // The seed is only useful if it reproduces the demo. Failing loudly here is
  // far better than finding out from a slide.
  const drift: string[] = [];
  if (result.totalWasted !== EXPECTED_SEED_OUTCOME.totalWasted) {
    drift.push(`totalWasted ${result.totalWasted} != ${EXPECTED_SEED_OUTCOME.totalWasted}`);
  }
  if (result.annualSavings !== EXPECTED_SEED_OUTCOME.annualSavings) {
    drift.push(`annualSavings ${result.annualSavings} != ${EXPECTED_SEED_OUTCOME.annualSavings}`);
  }
  if (result.subscriptions.length !== EXPECTED_SEED_OUTCOME.subscriptionCount) {
    drift.push(
      `${result.subscriptions.length} subscriptions, expected ${EXPECTED_SEED_OUTCOME.subscriptionCount}`,
    );
  }
  if (drift.length > 0 && answers.length === 0) {
    console.error(`\nSEED DRIFT: ${drift.join("; ")}`);
    process.exit(1);
  }
  if (answers.length > 0) {
    console.log(`\n(${answers.length} saved answer(s) applied, so totals differ from the baseline.)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
