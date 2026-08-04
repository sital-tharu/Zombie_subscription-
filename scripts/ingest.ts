/**
 * Batch-ingest real screenshots for dogfooding:
 *
 *   npm run ingest -- --dry-run    read and print, write nothing
 *   npm run ingest                 read, print, and persist
 *   npm run ingest -- --dir=other  a folder other than ./samples
 *
 * Runs every image in ./samples through the real extraction path -- the same
 * Gemini call and the same Zod validation the upload button uses -- then
 * analyses the store and prints the verdicts.
 *
 * ./samples is gitignored. Real financial screenshots never reach the repo, and
 * neither does anything derived from them.
 *
 * Two deliberate differences from the upload route:
 *
 * 1. Ids derive from the FILENAME, not randomUUID. Re-running the folder after
 *    tweaking the merchant map has to overwrite rather than silently double
 *    every transaction -- and during dogfooding you re-run constantly.
 * 2. --dry-run exists and is worth using first. This is real financial data;
 *    seeing what was read before committing it to a database is cheap.
 */
import "./load-env";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { analyze } from "../src/lib/correlate";
import { extractTransactions } from "../src/lib/extract";
import { hasGeminiKey } from "../src/lib/gemini";
import { merchantKeyOf, lookupSubscription, slugify } from "../src/lib/merchant-map";
import { getStore } from "../src/lib/store";
import type { StoredTransaction } from "../src/lib/types";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
};

// The free tier rate-limits, and extraction measured ~9s per image anyway.
const PAUSE_MS = 1000;

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dirArg = args.find((a) => a.startsWith("--dir="));
  const dir = resolve(process.cwd(), dirArg ? dirArg.slice(6) : "samples");

  if (!hasGeminiKey()) {
    console.error("GEMINI_API_KEY is not set. Add it to .env.local.");
    process.exit(1);
  }

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => extname(f).toLowerCase() in IMAGE_TYPES)
      .sort();
  } catch {
    console.error(`Cannot read ${dir}. Create it and drop your screenshots in.`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`No images in ${dir} (looking for ${Object.keys(IMAGE_TYPES).join(", ")}).`);
    process.exit(1);
  }

  console.log(`${files.length} image${files.length === 1 ? "" : "s"} in ${dir}`);
  console.log(dryRun ? "DRY RUN — nothing will be written.\n" : "Writing to the store.\n");

  const all: StoredTransaction[] = [];
  const failures: { file: string; error: string }[] = [];

  for (const [index, file] of files.entries()) {
    const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
    const bytes = readFileSync(join(dir, file));
    process.stdout.write(`[${index + 1}/${files.length}] ${file} … `);

    const started = Date.now();
    try {
      const extracted = await extractTransactions({ bytes, mimeType });
      console.log(`${extracted.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);

      const slug = slugify(file.replace(extname(file), ""));
      for (const [i, txn] of extracted.entries()) {
        const row: StoredTransaction = {
          id: `real-${slug}-${i + 1}`,
          merchant: txn.merchant,
          date: txn.date,
          total: txn.total,
          category: txn.category,
          source: "photo",
          createdAt: new Date().toISOString(),
        };
        all.push(row);
        // Show how each payee resolves. This is the line that reveals whether
        // the merchant map recognises your real UPI names -- an unmapped
        // subscription becomes a gap-handler question rather than a verdict.
        const mapped = lookupSubscription(txn.merchant);
        const tag = mapped ? `-> ${mapped.key}` : "unmapped";
        console.log(
          `        ${txn.date}  ${inr(txn.total).padStart(9)}  ${txn.merchant.padEnd(30)} ${tag}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAILED — ${message}`);
      failures.push({ file, error: message });
    }

    if (index < files.length - 1) await sleep(PAUSE_MS);
  }

  console.log(`\nExtracted ${all.length} transactions from ${files.length - failures.length} images.`);
  if (failures.length > 0) {
    console.log(`${failures.length} failed: ${failures.map((f) => f.file).join(", ")}`);
  }

  // Which merchants the map does not know. These become gap-handler questions
  // rather than verdicts, so this list is the input to extending the map.
  const unmapped = [...new Set(all.filter((t) => !lookupSubscription(t.merchant)).map((t) => t.merchant))];
  if (unmapped.length > 0) {
    console.log(`\nUnrecognised payees (${unmapped.length}):`);
    for (const m of unmapped) console.log(`  ${m.padEnd(34)} keys as ${merchantKeyOf(m)}`);
  }

  if (dryRun) {
    console.log("\nDry run — nothing written. Drop --dry-run to persist.");
    return;
  }

  const store = await getStore();
  await store.addTransactions(all);
  console.log(`\nWrote ${all.length} transactions to the ${store.mode} store.`);

  const everything = await store.listTransactions(5000);
  const seeded = everything.filter((t) => t.seeded).length;
  if (seeded > 0) {
    console.log(
      `\nNote: ${seeded} seeded demo rows are still present, so totals below mix demo and real data.`,
    );
    console.log("Run `npm run wipe:seed` to analyse only your own transactions.");
  }

  const answers = await store.listAnswers();
  const result = analyze(everything, undefined, { answers });

  console.log(`\n--- Verdicts as of ${result.asOf} ---\n`);
  if (result.subscriptions.length === 0) {
    console.log("  No recurring charges detected.");
    console.log("  Detection needs 3+ charges of the same merchant, 25-35 days apart.");
    console.log("  With only a few screenshots this is expected: capture more history,");
    console.log("  or screenshot a single merchant's filtered list to get a whole chain.");
    return;
  }

  for (const v of result.verdicts) {
    const money = v.zombieScore > 0 ? inr(v.zombieScore) : v.potentialWaste > 0 ? `(${inr(v.potentialWaste)} at risk)` : "-";
    console.log(`  ${v.merchant.padEnd(24)} ${v.verdict.padEnd(14)} ${v.confidence.padEnd(15)} ${money}`);
    console.log(`  ${" ".repeat(24)} ${v.reason}\n`);
  }
  console.log(`  Total wasted   : ${inr(result.totalWasted)}`);
  console.log(`  Annual savings : ${inr(result.annualSavings)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
