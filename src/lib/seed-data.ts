/**
 * The scripted demo history.
 *
 * Pure and framework-free on purpose: `scripts/seed.ts` writes it to the store,
 * and `scripts/test-logic.ts` asserts against it without touching a database.
 * The demo arc is encoded in these fixtures, so if the numbers are wrong here
 * they are wrong on stage.
 *
 * Every date is generated relative to `asOf`, so the dataset never goes stale.
 *
 * THREE CONSTRAINTS THAT ARE NOT OBVIOUS AND THAT SILENTLY DESTROY THE DEMO:
 *
 * 1. Not one background merchant may match `amazon`. Amazon Prime is the
 *    headline zombie precisely because there are zero Amazon purchases; a
 *    single stray Amazon row flips it to "used" and deletes 2093 rupees and the
 *    third demo beat with it. The donor project's seed scatters four such rows
 *    through its background noise.
 *
 * 2. No background merchant may reach three charges. Three charges 25-35 days
 *    apart within 10% of each other is the recurring-charge rule, and tripping
 *    it produces a sixth subscription card -- a phantom zombie, which then
 *    reports itself unused because its own charges are excluded from its own
 *    evidence. The donor seed trips this with three electricity bills.
 *
 *    Every background merchant is therefore capped at TWO charges. That is a
 *    stronger guarantee than spacing them carefully: two charges cannot chain
 *    no matter what their dates or amounts are, so the constraint holds without
 *    anyone re-checking gap arithmetic after an edit. ACT Fibernet is the proof
 *    it is needed -- 1499 twice, 31 days apart -- which would chain instantly
 *    if a third were ever added.
 *
 * 3. The last Zomato order must fall strictly between day 100 and day 130.
 *    "Orders stopped about four months ago" does not by itself give 800 rupees
 *    -- that figure needs exactly four charges to postdate the last order. At
 *    day 130 it becomes 1000, at day 100 it becomes 600, and both look
 *    perfectly plausible. Day 115 centres it with 15 days of margin either side.
 */
import { addDaysIso, todayIso } from "./dates";
import type { StoredTransaction } from "./types";

export interface SeedSpec {
  /** Anchor date. Everything is generated backwards from here. */
  asOf?: string;
}

type Category = "Food" | "Transport" | "Subscriptions" | "Shopping" | "Utilities";

interface Row {
  slug: string;
  merchant: string;
  category: Category;
  /** [daysAgo, amount] pairs. */
  charges: readonly (readonly [number, number])[];
}

/**
 * The five planted subscriptions. Between them they cover every verdict the
 * engine can reach: a never-used zombie, a gone-quiet zombie, a genuinely used
 * subscription, a recognised service we cannot observe, and a merchant we do
 * not recognise at all.
 */
const SUBSCRIPTIONS: readonly Row[] = [
  {
    // 299 x 7 = 2093, zero Amazon purchases anywhere. The first charge lands
    // around 25 January, so "2093 rupees on Prime since January" is true on any
    // plausible demo date.
    slug: "prime",
    merchant: "AMAZON PRIME",
    category: "Subscriptions",
    charges: [192, 162, 132, 102, 72, 42, 12].map((d) => [d, 299] as const),
  },
  {
    // Orders throughout, including one two days ago -- more recent than the
    // most recent charge, so both readings of the scoring rule agree on zero.
    slug: "swiggy-one",
    merchant: "SWIGGY ONE",
    category: "Subscriptions",
    charges: [156, 126, 96, 66, 36, 6].map((d) => [d, 499] as const),
  },
  {
    // 8 charges, last order at day 115 -> exactly 4 postdate it -> 800.
    slug: "zomato-gold",
    merchant: "RAZORPAY*ZOMATO GOLD",
    category: "Subscriptions",
    charges: [220, 190, 160, 130, 100, 70, 40, 10].map((d) => [d, 200] as const),
  },
  {
    // No transaction footprint -> unknown / LOW -> the gap handler.
    slug: "netflix",
    merchant: "NETFLIX",
    category: "Subscriptions",
    charges: [154, 124, 94, 64, 34, 4].map((d) => [d, 649] as const),
  },
  {
    // Unmapped merchant -> unknown / NONE. A weaker admission than Netflix's,
    // and the UI says so. Deliberately absent from the merchant map.
    slug: "kuku",
    merchant: "KUKU FM PREMIUM",
    category: "Subscriptions",
    charges: [99, 69, 39, 9].map((d) => [d, 99] as const),
  },
];

/**
 * Usage evidence. Amounts vary by well over 10% so these never chain into
 * subscriptions of their own -- if they did, they would be excluded from usage
 * evidence and the subscription they prove would flip to unused.
 */
const USAGE: readonly Row[] = [
  {
    slug: "swiggy",
    merchant: "SWIGGY",
    category: "Food",
    charges: [
      [104, 462], [88, 425], [61, 388], [47, 351], [33, 314], [19, 277], [2, 240],
    ],
  },
  {
    // Stops at day 115. This is the number the whole Zomato beat rests on.
    slug: "zomato",
    merchant: "ZOMATO",
    category: "Food",
    charges: [
      [204, 348], [186, 520], [168, 295], [149, 440], [133, 612], [115, 385],
    ],
  },
];

/**
 * Background noise, so the history looks real and the correlation has something
 * to reject. Note the absence of any Amazon merchant, and note that Chocolate
 * Room is here on purpose: it is the merchant that proves `ola` matching is
 * token-based rather than substring-based.
 *
 * Deliberately thin -- one merchant per *kind* of spending rather than several.
 * Firestore's free tier allows 50,000 document reads a day and one dashboard
 * render reads every transaction, so each background row is a recurring cost
 * paid on every page load by every visitor, for a fixed amount of realism. Two
 * cafes do not make the history look more real than one; they just make the
 * demo run out of quota sooner.
 *
 * Keep the variety, not the volume: if you add a merchant, consider whether it
 * represents a kind of spending not already here, and cap it at two charges.
 */
const BACKGROUND: readonly Row[] = [
  // Food
  { slug: "blinkit", merchant: "BLINKIT", category: "Food",
    charges: [[27, 275], [3, 342]] },
  { slug: "chai", merchant: "CHAI POINT", category: "Food",
    charges: [[16, 150], [1, 120]] },
  { slug: "chocolate-room", merchant: "CHOCOLATE ROOM", category: "Food",
    charges: [[95, 320], [37, 460]] },
  { slug: "dominos", merchant: "DOMINOS PIZZA", category: "Food",
    charges: [[76, 878], [22, 549]] },

  // Transport -- cab, fuel, bus and rail are four different kinds of trip, which
  // is why all four are here while two cab apps would not be.
  { slug: "rapido", merchant: "RAPIDO", category: "Transport",
    charges: [[26, 52], [5, 68]] },
  { slug: "indian-oil", merchant: "INDIAN OIL", category: "Transport",
    charges: [[62, 1650], [17, 2100]] },
  { slug: "bmtc", merchant: "BMTC BUS", category: "Transport",
    charges: [[21, 60], [7, 45]] },
  { slug: "irctc", merchant: "IRCTC", category: "Transport",
    charges: [[171, 890], [88, 1245]] },

  // Shopping -- Flipkart, Myntra, Nykaa. Never Amazon.
  { slug: "flipkart", merchant: "FLIPKART", category: "Shopping",
    charges: [[79, 1120], [18, 2340]] },
  { slug: "myntra", merchant: "MYNTRA", category: "Shopping",
    charges: [[108, 3250], [31, 1899]] },
  { slug: "nykaa", merchant: "NYKAA", category: "Shopping",
    charges: [[91, 1340], [25, 780]] },

  // Utilities -- monthly bills at a steady amount ARE a recurring charge by the
  // Layer 1 rule, which is why the two-charge cap below matters most here.
  { slug: "bescom", merchant: "BESCOM", category: "Utilities",
    charges: [[39, 860], [8, 1180]] },
  { slug: "act", merchant: "ACT FIBERNET", category: "Utilities",
    charges: [[36, 1499], [5, 1499]] },
  { slug: "indane", merchant: "INDANE GAS", category: "Utilities",
    charges: [[128, 1105], [33, 1105]] },
];

/**
 * Build the demo history. Ids are stable and readable (`seed-prime-3`) so the
 * evidence chain is legible when it is projected on a screen, and so re-seeding
 * overwrites rather than duplicates.
 */
export function buildSeedTransactions(spec: SeedSpec = {}): StoredTransaction[] {
  const asOf = spec.asOf ?? todayIso();
  const createdAt = new Date().toISOString();
  const rows: StoredTransaction[] = [];

  for (const group of [...SUBSCRIPTIONS, ...USAGE, ...BACKGROUND]) {
    // Oldest first, so the numeric suffix reads chronologically.
    const ordered = [...group.charges].sort((a, b) => b[0] - a[0]);
    ordered.forEach(([daysAgo, amount], index) => {
      rows.push({
        id: `seed-${group.slug}-${index + 1}`,
        merchant: group.merchant,
        date: addDaysIso(asOf, -daysAgo),
        total: amount,
        category: group.category,
        source: "seed",
        seeded: true,
        createdAt,
      });
    });
  }

  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
}

/** What `analyze()` must return over the seeded history. Asserted by the tests. */
export const EXPECTED_SEED_OUTCOME = {
  subscriptionCount: 5,
  totalWasted: 2893,
  annualSavings: 5988,
  verdicts: [
    { merchantKey: "amazon-prime", verdict: "likely-unused", confidence: "high", zombieScore: 2093 },
    { merchantKey: "zomato-gold", verdict: "likely-unused", confidence: "high", zombieScore: 800 },
    { merchantKey: "netflix", verdict: "unknown", confidence: "low", zombieScore: 0 },
    { merchantKey: "kuku-fm-premium", verdict: "unknown", confidence: "none", zombieScore: 0 },
    { merchantKey: "swiggy-one", verdict: "used", confidence: "high", zombieScore: 0 },
  ],
} as const;
