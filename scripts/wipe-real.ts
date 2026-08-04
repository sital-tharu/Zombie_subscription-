/**
 * Remove ingested real transactions, leaving the scripted demo untouched:
 *   npm run wipe:real
 *
 * The mirror of wipe:seed, and the one that matters for privacy. The deployed
 * dashboard is publicly readable and has no login of its own — only the write
 * routes check the owner key — so the production database must contain nothing
 * but synthetic data.
 *
 * Run this against Firestore before deploying, and dogfood locally with
 * ZOMBIE_STORE=local so real GPay history never leaves the machine.
 */
import "./load-env";
import { getStore } from "../src/lib/store";

async function main(): Promise<void> {
  const store = await getStore();
  const all = await store.listTransactions(5000);
  const real = all.filter((t) => !t.seeded);

  console.log(`Store: ${store.mode}`);
  console.log(`${all.length} transactions — ${all.length - real.length} seeded, ${real.length} real\n`);

  if (real.length === 0) {
    console.log("No real transactions to remove. Safe to expose publicly.");
    return;
  }

  for (const t of real) {
    console.log(`  removing ${t.id.padEnd(28)} ${t.date}  ${t.merchant}`);
  }

  const removed = await store.deleteTransactions(real.map((t) => t.id));
  const after = await store.listTransactions(5000);
  console.log(`\nRemoved ${removed}. ${after.length} remain, all seeded: ${after.every((t) => t.seeded)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
