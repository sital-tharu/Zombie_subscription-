/**
 * Put the demo back exactly as the README describes it:
 *   npm run demo:reset
 *
 * Everything a live demo accumulates is state the next demo does not want. An
 * answered gap question stops the agent asking it, a ticked cancellation stops
 * a subscription being counted, an accepted proposal opens on a checklist
 * instead of a "generate my plan" button, and one uploaded screenshot leaves a
 * real transaction in a database that is meant to hold nothing but synthetic
 * data. Each is invisible on its own and together they quietly move every
 * headline figure -- which is how the deployed dashboard came to show 5,987
 * instead of 2,893.
 *
 * So this clears all four and re-seeds, then prints the verdicts and checks
 * them against EXPECTED_SEED_OUTCOME. Run it before recording anything.
 *
 * Destructive by design, but only to demo state: every row it removes is
 * either regenerated here or was never meant to be on this machine.
 */
import "./load-env";
import { analyze } from "../src/lib/correlate";
import { buildSeedTransactions, EXPECTED_SEED_OUTCOME } from "../src/lib/seed-data";
import { getStore } from "../src/lib/store";
import { inr } from "../src/lib/format";

async function main(): Promise<void> {
  const store = await getStore();
  console.log(`Store: ${store.mode}\n`);

  // 1. Real transactions -- the privacy one. The deployed dashboard is publicly
  //    readable and has no login of its own.
  const all = await store.listTransactions(5000);
  const real = all.filter((t) => !t.seeded);
  if (real.length > 0) {
    for (const t of real) {
      console.log(`  removing real  ${t.id.padEnd(30)} ${t.date}  ${t.merchant}`);
    }
    await store.deleteTransactions(real.map((t) => t.id));
  }
  console.log(`Real transactions removed: ${real.length}`);

  // 2. Gap-handler answers. These outrank inference in both directions, so a
  //    leftover "yes" silently deletes a zombie from the demo.
  const answers = await store.listAnswers();
  for (const a of answers) {
    console.log(`  clearing answer   ${a.merchantKey} (used: ${a.used})`);
    await store.clearAnswer(a.merchantKey);
  }
  console.log(`Answers cleared: ${answers.length}`);

  // 3. Declared cancellations, which drop subscriptions out of the run rate.
  const cancellations = await store.listCancellations();
  for (const c of cancellations) {
    console.log(`  clearing cancel   ${c.merchantKey} (${c.cancelledAt})`);
    await store.clearCancellation(c.merchantKey);
  }
  console.log(`Cancellations cleared: ${cancellations.length}`);

  // 4. Proposals, so the plan panel opens on its first-run state.
  const proposals = await store.clearProposals();
  console.log(`Proposals cleared: ${proposals}`);

  // 5. Re-seed and verify.
  const seeded = buildSeedTransactions();
  await store.replaceSeeded(seeded);
  console.log(`\nSeeded ${seeded.length} transactions.\n`);

  const result = analyze(await store.listTransactions(5000));
  for (const v of result.verdicts) {
    const money =
      v.zombieScore > 0
        ? inr(v.zombieScore)
        : v.potentialWaste > 0
          ? `(${inr(v.potentialWaste)} at risk)`
          : "-";
    console.log(
      `  ${v.merchant.padEnd(20)} ${v.verdict.padEnd(14)} ${v.confidence.padEnd(10)} ${money}`,
    );
  }
  console.log(`\n  Total wasted  : ${inr(result.totalWasted)}`);
  console.log(`  Annual savings: ${inr(result.annualSavings)}`);
  console.log(`  Monthly total : ${inr(result.monthlyRunRate)}`);

  const drift: string[] = [];
  if (result.totalWasted !== EXPECTED_SEED_OUTCOME.totalWasted) {
    drift.push(`totalWasted ${result.totalWasted} != ${EXPECTED_SEED_OUTCOME.totalWasted}`);
  }
  if (result.annualSavings !== EXPECTED_SEED_OUTCOME.annualSavings) {
    drift.push(`annualSavings ${result.annualSavings} != ${EXPECTED_SEED_OUTCOME.annualSavings}`);
  }
  if (result.subscriptions.length !== EXPECTED_SEED_OUTCOME.subscriptionCount) {
    drift.push(
      `subscriptions ${result.subscriptions.length} != ${EXPECTED_SEED_OUTCOME.subscriptionCount}`,
    );
  }

  if (drift.length > 0) {
    console.error(`\nDEMO IS NOT CLEAN:\n  ${drift.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nDemo restored and verified against EXPECTED_SEED_OUTCOME.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
