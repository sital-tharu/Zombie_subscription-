/**
 * End-to-end check of screenshot intake:
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-extract.ts
 *
 * Renders a synthetic GPay-style transaction list to PNG and runs it through
 * the real extraction path -- Gemini, then the response schema, then Zod. Not a
 * substitute for testing against genuine screenshots, but it exercises the one
 * part of the pipeline that unit tests cannot reach, and it does so without
 * committing anyone's real financial data to the repo.
 */
import "./load-env";
import sharp from "sharp";
import { extractTransactions } from "../src/lib/extract";

const ROWS = [
  ["Netflix", "₹649", "31 Jul 2026"],
  ["RAZORPAY*ZOMATO GOLD", "₹200", "25 Jul 2026"],
  ["Blinkit", "₹342", "22 Jul 2026"],
  ["SWIGGY", "₹240", "18 Jul 2026"],
  ["AMAZON PRIME", "₹299", "23 Jul 2026"],
];

function buildSvg(): string {
  const rows = ROWS.map(([name, amount, date], i) => {
    const y = 150 + i * 96;
    return `
      <circle cx="52" cy="${y + 14}" r="22" fill="#e8eaed"/>
      <text x="92" y="${y + 8}" font-family="Arial" font-size="24" fill="#202124">${name}</text>
      <text x="92" y="${y + 38}" font-family="Arial" font-size="19" fill="#5f6368">${date}</text>
      <text x="620" y="${y + 16}" font-family="Arial" font-size="24" fill="#202124" text-anchor="end">${amount}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="640">
    <rect width="680" height="640" fill="#ffffff"/>
    <text x="40" y="64" font-family="Arial" font-size="30" fill="#202124">Transaction history</text>
    <text x="40" y="100" font-family="Arial" font-size="20" fill="#5f6368">Google Pay</text>
    ${rows}
  </svg>`;
}

async function main(): Promise<void> {
  const png = await sharp(Buffer.from(buildSvg())).png().toBuffer();
  console.log(`rendered a ${png.length}-byte synthetic screenshot\n`);

  const started = Date.now();
  const extracted = await extractTransactions({
    bytes: png,
    mimeType: "image/png",
    asOf: "2026-08-04",
  });
  console.log(`extracted ${extracted.length} transactions in ${Date.now() - started} ms\n`);

  for (const txn of extracted) {
    console.log(`  ${txn.date}  ${String(txn.total).padStart(6)}  ${txn.category.padEnd(14)} ${txn.merchant}`);
  }

  const missed = ROWS.filter(
    ([name]) =>
      !extracted.some((t) =>
        t.merchant.toLowerCase().includes(name.toLowerCase().split("*").pop()!.slice(0, 6)),
      ),
  );
  console.log(
    missed.length === 0
      ? "\nAll rows recovered."
      : `\nMissed: ${missed.map((r) => r[0]).join(", ")}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
