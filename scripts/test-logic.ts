/**
 * Verdict engine regression checks:
 *   npm run test:logic
 *
 * Pure functions only -- no Firestore, no Gemini, no credentials, no network.
 * If this file ever needs an environment variable, the engine boundary has been
 * broken and `npm run lint` should have caught it first.
 *
 * The verdict engine is the product, and a wrong number on stage is fatal, so
 * every change to Layers 1-3 ships with a check here. Fixtures are pinned to a
 * fixed asOf rather than the system clock: a suite that passes today and fails
 * in November is not a suite.
 */
import assert from "node:assert";
import {
  analyze,
  applyUserAnswer,
  isUsageEvidence,
  LOOKBACK_DAYS,
  rankVerdicts,
} from "../src/lib/correlate";
import { addDaysIso, round2 } from "../src/lib/dates";
import {
  lookupByKey,
  matchesPattern,
  MERCHANTS,
  merchantKeyOf,
  tokenize,
  validateMerchantMap,
} from "../src/lib/merchant-map";
import {
  allowedNumbers,
  buildProposalInput,
  foreignNumbers,
  planIsGrounded,
  templatePlan,
} from "../src/lib/proposal";
import { buildSeedTransactions, EXPECTED_SEED_OUTCOME } from "../src/lib/seed-data";
import { detectSubscriptions, monthlyTotal } from "../src/lib/subscriptions";
import type { TransactionLike, UsageVerdict } from "../src/lib/types";

const ASOF = "2026-08-04";
const ago = (days: number) => addDaysIso(ASOF, -days);

let seq = 0;
/** Fixture transaction, dated `days` before ASOF. */
function t(merchant: string, days: number, total: number): TransactionLike {
  return { id: `t${++seq}`, merchant, date: ago(days), total };
}

const passes: string[] = [];
const failures: { name: string; error: string }[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passes.push(name);
  } catch (error) {
    failures.push({
      name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function verdictFor(result: ReturnType<typeof analyze>, key: string): UsageVerdict {
  const found = result.verdicts.find((v) => v.merchantKey === key);
  assert.ok(found, `no verdict for ${key}`);
  return found;
}

// Shared fixtures. Function declarations, not consts -- checks run at the point
// they are written, so anything they reference has to be hoisted.

/** Amazon Prime: 7 charges of 299 spanning 180 days. Never used. */
function primeFixture(): TransactionLike[] {
  return [12, 42, 72, 102, 132, 162, 192].map((d) => t("AMAZON PRIME", d, 299));
}

/** Netflix: 6 charges of 649. No observable footprint -> gap handler. */
function netflixFixture(): TransactionLike[] {
  return [4, 34, 64, 94, 124, 154].map((d) => t("NETFLIX", d, 649));
}

/** Kuku FM: 4 charges of 99 from an unmapped merchant -> gap handler. */
function kukuFixture(): TransactionLike[] {
  return [9, 39, 69, 99].map((d) => t("KUKU FM PREMIUM", d, 99));
}

// ---------------------------------------------------------------------------
// Layer 1 -- recurring detection
// ---------------------------------------------------------------------------

check("L1: three monthly charges become one subscription with the full chain", () => {
  const subs = detectSubscriptions(
    [6, 36, 66].map((d) => t("Netflix", d, 649)),
    ASOF,
  );
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].occurrences, 3);
  assert.strictEqual(subs[0].monthlyAmount, 649);
  assert.strictEqual(subs[0].totalPaid, 1947);
  assert.strictEqual(subs[0].firstDate, ago(66));
  assert.strictEqual(subs[0].lastDate, ago(6));
  assert.strictEqual(subs[0].cadenceDays, 30);
  assert.strictEqual(subs[0].daysSinceLastCharge, 6);
});

check("L1: irregular same-merchant orders are not a subscription", () => {
  const subs = detectSubscriptions(
    [t("Swiggy", 1, 420), t("Swiggy", 5, 380), t("Swiggy", 12, 510)],
    ASOF,
  );
  assert.strictEqual(subs.length, 0);
});

check("L1: a hike within 10% chains and monthlyAmount tracks the latest charge", () => {
  const subs = detectSubscriptions(
    [t("Netflix", 6, 699), t("Netflix", 36, 649), t("Netflix", 66, 649)],
    ASOF,
  );
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].monthlyAmount, 699);
});

check("L1: a jump beyond 10% breaks the chain", () => {
  const subs = detectSubscriptions(
    [t("Gym", 6, 1500), t("Gym", 36, 1000), t("Gym", 66, 1000)],
    ASOF,
  );
  assert.strictEqual(subs.length, 0);
});

check("L1: cadence boundaries -- 25 and 35 days chain, 24 and 36 do not", () => {
  assert.strictEqual(
    detectSubscriptions([t("A", 0, 100), t("A", 25, 100), t("A", 50, 100)], ASOF).length,
    1,
    "25-day gaps should chain",
  );
  assert.strictEqual(
    detectSubscriptions([t("B", 0, 100), t("B", 35, 100), t("B", 70, 100)], ASOF).length,
    1,
    "35-day gaps should chain",
  );
  assert.strictEqual(
    detectSubscriptions([t("C", 0, 100), t("C", 36, 100), t("C", 72, 100)], ASOF).length,
    0,
    "36-day gaps must not chain",
  );
  // 24-day gaps are treated as intra-month extras and skipped, so the streak
  // never reaches three even though there are four transactions.
  assert.strictEqual(
    detectSubscriptions(
      [t("D", 0, 100), t("D", 24, 100), t("D", 48, 100), t("D", 72, 100)],
      ASOF,
    ).length,
    0,
    "24-day gaps must not chain",
  );
});

check("L1: intra-month extras and duplicates stay out of chargeIds and totalPaid", () => {
  const subs = detectSubscriptions(
    [
      t("Prime", 3, 299),
      t("Prime", 3, 299), // same-day duplicate, e.g. a re-seed
      t("Prime", 10, 299), // extra purchase inside the month
      t("Prime", 33, 299),
      t("Prime", 63, 299),
    ],
    ASOF,
  );
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].occurrences, 3);
  assert.strictEqual(subs[0].chargeIds.length, 3);
  assert.strictEqual(subs[0].totalPaid, 897, "duplicates must not inflate totalPaid");
});

check("L1: two occurrences yield no subscription and no verdict", () => {
  // The PRD describes a "detecting" state for fewer than two charges. Layer 1
  // requires three, so that rule is strictly weaker and can never bind --
  // "detecting" is deliberately not a member of the Verdict union.
  const result = analyze([t("Hotstar", 6, 299), t("Hotstar", 36, 299)], ASOF);
  assert.strictEqual(result.subscriptions.length, 0);
  assert.strictEqual(result.verdicts.length, 0);
});

check("L1: chargeIds ascend, mirror charges, and sum to totalPaid", () => {
  const subs = detectSubscriptions(
    [10, 40, 70, 100].map((d) => t("Zomato Gold", d, 200)),
    ASOF,
  );
  const sub = subs[0];
  assert.deepStrictEqual(
    sub.chargeIds,
    sub.charges.map((c) => c.id),
    "chargeIds must mirror charges exactly",
  );
  const dates = sub.charges.map((c) => c.date);
  assert.deepStrictEqual([...dates].sort(), dates, "charges must be ascending");
  assert.strictEqual(
    sub.totalPaid,
    round2(sub.charges.reduce((s, c) => s + c.amount, 0)),
  );
});

check("L1: the asOf horizon hides future-dated rows", () => {
  const withFuture = [
    t("Netflix", -30, 649), // dated a month AFTER asOf
    t("Netflix", 6, 649),
    t("Netflix", 36, 649),
    t("Netflix", 66, 649),
  ];
  const subs = detectSubscriptions(withFuture, ASOF);
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].occurrences, 3, "the future row must be invisible");
  assert.strictEqual(subs[0].lastDate, ago(6));
  assert.strictEqual(subs[0].totalPaid, 1947);
});

check("L1: a malformed asOf throws instead of silently using today", () => {
  assert.throws(() => detectSubscriptions([], "04-08-2026"));
  assert.throws(() => detectSubscriptions([], "2026-02-31"));
});

check("L1: drifting payee names collapse into one chain, not two", () => {
  // The failure this prevents: two Prime cards on stage, each with half the money.
  const subs = detectSubscriptions(
    [
      t("AMAZON PRIME", 12, 299),
      t("Amazon Prime*IN", 42, 299),
      t("RAZORPAY*AMAZON PRIME", 72, 299),
      t("amazon prime", 102, 299),
    ],
    ASOF,
  );
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].merchantKey, "amazon-prime");
  assert.strictEqual(subs[0].occurrences, 4);
});

check("L1: monthlyTotal sums the detected subscriptions", () => {
  const subs = detectSubscriptions(
    [
      ...[6, 36, 66].map((d) => t("Netflix", d, 649)),
      ...[8, 38, 68].map((d) => t("Spotify", d, 119)),
    ],
    ASOF,
  );
  assert.strictEqual(subs.length, 2);
  assert.strictEqual(monthlyTotal(subs), 768);
});

// ---------------------------------------------------------------------------
// Merchant map and the self-validation trap
// ---------------------------------------------------------------------------

check("MAP: validateMerchantMap reports no problems", () => {
  assert.deepStrictEqual(validateMerchantMap(), []);
  assert.strictEqual(MERCHANTS.length, 21);
});

check("MAP: no subscription pattern anywhere is usage evidence for any entry", () => {
  // All-pairs. Loops the whole map, so entries added later are covered for free.
  const empty = new Set<string>();
  for (const owner of MERCHANTS) {
    for (const pattern of owner.subscriptionPatterns) {
      for (const entry of MERCHANTS) {
        const txn = { id: "x", merchant: pattern, date: ago(1), total: 100 };
        assert.strictEqual(
          isUsageEvidence(txn, entry, empty),
          false,
          `"${pattern}" (${owner.key}) was accepted as usage evidence for ${entry.key}`,
        );
      }
    }
  }
});

check("MAP: the trap is real -- precedence is what defuses it, not luck", () => {
  // Without the subscription-pattern check, an Amazon Prime charge WOULD match
  // Amazon Prime's own usage pattern. Proving the collision exists is what
  // makes the previous check meaningful rather than vacuous.
  const prime = lookupByKey("amazon-prime");
  assert.ok(prime && prime.footprint === "transaction");
  const tokens = tokenize("AMAZON PRIME");
  assert.ok(
    prime.usagePatterns.some((p) => matchesPattern(tokens, p)),
    "expected the raw collision to exist",
  );
});

check("MAP: token matching respects word boundaries", () => {
  assert.strictEqual(matchesPattern(tokenize("Chocolate Room"), "ola"), false);
  assert.strictEqual(matchesPattern(tokenize("OLA CABS"), "ola"), true);
  assert.strictEqual(matchesPattern(tokenize("UBER ONE"), "uber one"), true);
  assert.strictEqual(matchesPattern(tokenize("Uber"), "uber one"), false);
});

check("MAP: a plain Amazon charge does not key to amazon-prime", () => {
  // If it did, the trap would reappear at the grouping layer: shopping charges
  // would join the Prime chain and then be excluded from their own evidence.
  assert.strictEqual(merchantKeyOf("Amazon"), "amazon");
  assert.strictEqual(merchantKeyOf("AMAZON PRIME"), "amazon-prime");
  assert.strictEqual(merchantKeyOf("RAZORPAY*ZOMATO GOLD"), "zomato-gold");
  assert.strictEqual(merchantKeyOf("Kuku FM Premium"), "kuku-fm-premium");
});

check("MAP: rail prefixes are stripped by token, not by splitting on an asterisk", () => {
  assert.deepStrictEqual(tokenize("RAZORPAY*ZOMATO GOLD"), ["zomato", "gold"]);
  // The naive rule -- keep only what follows the asterisk -- yields ["in"].
  assert.deepStrictEqual(tokenize("Amazon Prime*IN"), ["amazon", "prime", "in"]);
  // Never strip to nothing: PAYTM is a merchant in its own right.
  assert.deepStrictEqual(tokenize("PAYTM"), ["paytm"]);
});

// ---------------------------------------------------------------------------
// THE TRAP, end to end
// ---------------------------------------------------------------------------

check("TRAP: Amazon Prime alone in history is never judged used", () => {
  // If this ever fails, the app silently reports zero zombies and the entire
  // product thesis evaporates with no error message. Never weaken it.
  const result = analyze(
    [12, 42, 72, 102, 132, 162, 192].map((d) => t("AMAZON PRIME", d, 299)),
    ASOF,
  );
  const prime = verdictFor(result, "amazon-prime");
  assert.notStrictEqual(prime.verdict, "used");
  assert.strictEqual(prime.verdict, "likely-unused");
  assert.strictEqual(prime.confidence, "high");
  assert.strictEqual(prime.zombieScore, 2093);
  assert.strictEqual(prime.wastedCharges.length, 7);
});

check("TRAP: a genuine Amazon order does flip Prime to used", () => {
  const result = analyze(
    [
      ...[12, 42, 72, 102, 132, 162, 192].map((d) => t("AMAZON PRIME", d, 299)),
      t("AMAZON", 20, 1450),
    ],
    ASOF,
  );
  const prime = verdictFor(result, "amazon-prime");
  assert.strictEqual(prime.verdict, "used");
  assert.strictEqual(prime.zombieScore, 0);
  assert.strictEqual(prime.evidence.matchesInWindow.length, 1);
});

check("TRAP: recurring Amazon shopping does not make Prime look unused", () => {
  // Three similar monthly Amazon purchases chain into their own subscription.
  // If id-exclusion were global, those charges would be struck from Prime's
  // evidence and an actively used Prime would be flagged as a zombie -- the
  // worst failure this product has.
  const result = analyze(
    [
      ...[12, 42, 72, 102, 132, 162, 192].map((d) => t("AMAZON PRIME", d, 299)),
      ...[15, 45, 75].map((d) => t("AMAZON", d, 1200)),
    ],
    ASOF,
  );
  const prime = verdictFor(result, "amazon-prime");
  assert.strictEqual(prime.verdict, "used");
  assert.strictEqual(prime.zombieScore, 0);
});

check("TRAP: a subscription's own charges are excluded by id as well as by pattern", () => {
  const uberOne = lookupByKey("uber-one");
  assert.ok(uberOne && uberOne.footprint === "transaction");
  const ownCharge = { id: "own", merchant: "UBER ONE", date: ago(5), total: 149 };
  // Belt: excluded by id.
  assert.strictEqual(isUsageEvidence(ownCharge, uberOne, new Set(["own"])), false);
  // Braces: still rejected with an empty exclusion set, via pattern precedence.
  assert.strictEqual(isUsageEvidence(ownCharge, uberOne, new Set()), false);
  // And a real ride is evidence.
  const ride = { id: "r", merchant: "UBER INDIA SYSTEMS", date: ago(5), total: 240 };
  assert.strictEqual(isUsageEvidence(ride, uberOne, new Set()), true);
});

// ---------------------------------------------------------------------------
// Scoring -- the money
// ---------------------------------------------------------------------------

/** Zomato Gold: 8 charges of 200, orders stop 115 days ago. Expect exactly 800. */
function zomatoFixture(): TransactionLike[] {
  return [
    ...[10, 40, 70, 100, 130, 160, 190, 220].map((d) => t("RAZORPAY*ZOMATO GOLD", d, 200)),
    // Amounts vary by more than 10% so the orders never chain into a
    // subscription of their own.
    ...([[115, 385], [133, 612], [149, 440], [168, 295], [186, 520], [204, 348]] as const).map(
      ([d, amt]) => t("ZOMATO", d, amt),
    ),
  ];
}

check("SCORE: zombieScore is the exact sum of the charges after last usage", () => {
  const result = analyze(zomatoFixture(), ASOF);
  const zomato = verdictFor(result, "zomato-gold");
  assert.strictEqual(zomato.verdict, "likely-unused");
  assert.strictEqual(zomato.zombieScore, 800);
  assert.strictEqual(zomato.wastedCharges.length, 4, "4 of 8 charges, not all 8");
  assert.deepStrictEqual(
    zomato.wastedCharges.map((c) => c.date),
    [ago(100), ago(70), ago(40), ago(10)],
  );
  assert.strictEqual(
    zomato.zombieScore,
    round2(zomato.wastedCharges.reduce((s, c) => s + c.amount, 0)),
    "every rupee must come from a listed charge",
  );
});

check("SCORE: last usage outside the window still bounds the score", () => {
  // The doubling bug. Derive lastUsage from the window-filtered list and it
  // comes back null, the never-used branch fires, and this reads 1600.
  const zomato = verdictFor(analyze(zomatoFixture(), ASOF), "zomato-gold");
  assert.strictEqual(zomato.evidence.matchesInWindow.length, 0, "nothing in the window");
  assert.ok(zomato.evidence.lastUsage, "but usage exists in full history");
  assert.strictEqual(zomato.evidence.lastUsage.date, ago(115));
  assert.strictEqual(zomato.evidence.daysSinceLastUsage, 115);
  assert.notStrictEqual(zomato.zombieScore, 1600);
  assert.strictEqual(zomato.zombieScore, 800);
});

check("SCORE: a charge on the same day as usage is not waste", () => {
  // Usage at day 102 sits outside the 90-day window, so the verdict is
  // likely-unused -- but the charge billed that same day was used.
  const result = analyze(
    [
      ...[12, 42, 72, 102, 132, 162, 192].map((d) => t("AMAZON PRIME", d, 299)),
      t("AMAZON", 102, 899),
    ],
    ASOF,
  );
  const prime = verdictFor(result, "amazon-prime");
  assert.strictEqual(prime.verdict, "likely-unused");
  assert.strictEqual(prime.wastedCharges.length, 3, "days 72, 42, 12 -- not the day-102 charge");
  assert.strictEqual(prime.zombieScore, 897);
});

check("SCORE: wastedCharges is always a contiguous tail of the charge chain", () => {
  // Ascending chargeIds make this an invariant rather than a hopeful filter.
  // If the score ever picks up a non-tail charge, this fires instead of the
  // number quietly changing.
  const result = analyze([...zomatoFixture(), ...primeFixture(), ...netflixFixture()], ASOF);
  for (const v of result.verdicts) {
    const tail = v.evidence.charges.slice(v.evidence.charges.length - v.wastedCharges.length);
    assert.deepStrictEqual(
      v.wastedCharges,
      v.wastedCharges.length === 0 ? [] : tail,
      `${v.merchantKey}: wastedCharges is not a tail slice`,
    );
    assert.ok(
      v.zombieScore <= v.evidence.totalPaid,
      `${v.merchantKey}: score exceeds total paid`,
    );
  }
});

check("SCORE: paise sum without float drift", () => {
  const subs = detectSubscriptions(
    [6, 36, 66].map((d) => t("Micro", d, 82.6)),
    ASOF,
  );
  assert.strictEqual(subs[0].totalPaid, 247.8, "not 247.79999999999998");
});

// ---------------------------------------------------------------------------
// Evidence gap handler
// ---------------------------------------------------------------------------

check("GAP: a recognised service with no footprint is unknown / low, scoring zero", () => {
  const netflix = verdictFor(analyze(netflixFixture(), ASOF), "netflix");
  assert.strictEqual(netflix.verdict, "unknown");
  assert.strictEqual(netflix.confidence, "low");
  assert.strictEqual(netflix.zombieScore, 0, "no evidence means no claim");
  assert.deepStrictEqual(netflix.wastedCharges, []);
  assert.ok(netflix.question);
  assert.ok(netflix.question.includes("90"), "the question states the window");
  assert.strictEqual(netflix.potentialWaste, 3894);
});

check("GAP: an unmapped merchant is unknown / none, a weaker claim than low", () => {
  const kuku = verdictFor(analyze(kukuFixture(), ASOF), "kuku-fm-premium");
  assert.strictEqual(kuku.verdict, "unknown");
  assert.strictEqual(kuku.confidence, "none");
  assert.strictEqual(kuku.evidence.footprint, "unmapped");
  assert.strictEqual(kuku.zombieScore, 0);
  assert.strictEqual(kuku.potentialWaste, 396);
  assert.ok(kuku.question);
});

check("GAP: needsInput holds unanswered unknowns, ranked by what answering is worth", () => {
  const result = analyze([...netflixFixture(), ...kukuFixture(), ...primeFixture()], ASOF);
  assert.deepStrictEqual(
    result.needsInput.map((v) => v.merchantKey),
    ["netflix", "kuku-fm-premium"],
    "3894 before 396; amazon-prime is judged, not asked",
  );
});

check("GAP: an unanswered unknown adds nothing to either headline", () => {
  const withNetflix = analyze([...primeFixture(), ...netflixFixture()], ASOF);
  const withoutNetflix = analyze(primeFixture(), ASOF);
  assert.strictEqual(withNetflix.totalWasted, withoutNetflix.totalWasted);
  assert.strictEqual(withNetflix.annualSavings, withoutNetflix.annualSavings);
  assert.strictEqual(withNetflix.totalWasted, 2093);
});

// ---------------------------------------------------------------------------
// User answers outrank inference
// ---------------------------------------------------------------------------

check("ANSWER: no promotes to likely-unused, user-confirmed, priced on the full chain", () => {
  const answered = analyze([...primeFixture(), ...netflixFixture()], ASOF, {
    answers: [{ merchantKey: "netflix", used: false, answeredAt: "2026-08-04T10:00:00Z" }],
  });
  const netflix = verdictFor(answered, "netflix");
  assert.strictEqual(netflix.verdict, "likely-unused");
  assert.strictEqual(netflix.confidence, "user-confirmed");
  assert.strictEqual(netflix.zombieScore, 3894);
  assert.strictEqual(netflix.wastedCharges.length, 6);
  assert.strictEqual(netflix.question, null);
  assert.strictEqual(netflix.potentialWaste, 0);
  // The demo beat: the headline moves because the user supplied the evidence
  // the agent admitted it lacked.
  assert.strictEqual(answered.totalWasted, 5987);
  assert.strictEqual(answered.annualSavings, 12 * (299 + 649));
  assert.strictEqual(answered.needsInput.length, 0, "an answered unknown leaves the queue");
});

check("ANSWER: yes settles it as used with a zero score", () => {
  const answered = analyze(netflixFixture(), ASOF, {
    answers: [{ merchantKey: "netflix", used: true, answeredAt: "2026-08-04T10:00:00Z" }],
  });
  const netflix = verdictFor(answered, "netflix");
  assert.strictEqual(netflix.verdict, "used");
  assert.strictEqual(netflix.confidence, "user-confirmed");
  assert.strictEqual(netflix.zombieScore, 0);
  assert.strictEqual(answered.totalWasted, 0);
  assert.strictEqual(answered.needsInput.length, 0);
});

check("ANSWER: an answer overrides a confident inference, not just an unknown", () => {
  const prime = verdictFor(analyze(primeFixture(), ASOF), "amazon-prime");
  assert.strictEqual(prime.zombieScore, 2093);
  const corrected = applyUserAnswer(prime, {
    merchantKey: "amazon-prime",
    used: true,
    answeredAt: "2026-08-04T10:00:00Z",
  });
  assert.strictEqual(corrected.verdict, "used");
  assert.strictEqual(corrected.zombieScore, 0);
  assert.ok(corrected.evidence.userAnswer);
});

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

check("CONF: a dataset shorter than the window drops confidence to medium", () => {
  // The only honest source of MEDIUM in P0. The claim "no activity in 90 days"
  // is not supportable from 62 days of history, so the window shrinks and the
  // confidence says so.
  const result = analyze(
    [0, 31, 62].map((d) => t("AMAZON PRIME", d, 299)),
    ASOF,
  );
  assert.strictEqual(result.lookbackDays, 62);
  const prime = verdictFor(result, "amazon-prime");
  assert.strictEqual(prime.verdict, "likely-unused");
  assert.strictEqual(prime.confidence, "medium");
  assert.strictEqual(prime.evidence.lookbackDays, 62);
});

check("CONF: a full window keeps confidence high", () => {
  const result = analyze(primeFixture(), ASOF);
  assert.strictEqual(result.lookbackDays, LOOKBACK_DAYS);
  assert.strictEqual(verdictFor(result, "amazon-prime").confidence, "high");
});

check("CONF: confidence is always one of the five words, never a number", () => {
  const allowed = new Set(["high", "medium", "low", "none", "user-confirmed"]);
  const result = analyze(
    [...primeFixture(), ...netflixFixture(), ...kukuFixture(), ...zomatoFixture()],
    ASOF,
  );
  for (const v of result.verdicts) {
    assert.ok(allowed.has(v.confidence), `unexpected confidence: ${v.confidence}`);
    assert.strictEqual(
      typeof (v as unknown as { confidenceScore?: number }).confidenceScore,
      "undefined",
      "no numeric confidence may leak onto a verdict",
    );
  }
});

// ---------------------------------------------------------------------------
// Totals, ranking and determinism
// ---------------------------------------------------------------------------

/** The full demo history, five planted subscriptions. */
function demoFixture(): TransactionLike[] {
  return [
    ...primeFixture(),
    ...zomatoFixture(),
    ...[6, 36, 66, 96, 126, 156].map((d) => t("SWIGGY ONE", d, 499)),
    ...[2, 19, 33, 47, 61, 88, 104].map((d, i) => t("SWIGGY", d, 240 + i * 37)),
    ...netflixFixture(),
    ...kukuFixture(),
  ];
}

check("TOTALS: the headline reconciles against the individual charges", () => {
  const result = analyze(demoFixture(), ASOF);
  const sumOfScores = round2(result.verdicts.reduce((s, v) => s + v.zombieScore, 0));
  const sumOfCharges = round2(
    result.verdicts.flatMap((v) => v.wastedCharges).reduce((s, c) => s + c.amount, 0),
  );
  assert.strictEqual(result.totalWasted, sumOfScores);
  assert.strictEqual(result.totalWasted, sumOfCharges);
  assert.strictEqual(result.totalWasted, 2893);
});

check("TOTALS: annualSavings counts likely-unused only", () => {
  const result = analyze(demoFixture(), ASOF);
  const expected = round2(
    12 *
      result.verdicts
        .filter((v) => v.verdict === "likely-unused")
        .reduce((s, v) => s + v.monthlyAmount, 0),
  );
  assert.strictEqual(result.annualSavings, expected);
  assert.strictEqual(result.annualSavings, 5988, "12 x (299 + 200)");
});

check("RANK: verdicts are ordered by money wasted, with a total tie-break", () => {
  const result = analyze(demoFixture(), ASOF);
  assert.deepStrictEqual(
    result.verdicts.map((v) => v.merchantKey),
    ["amazon-prime", "zomato-gold", "netflix", "kuku-fm-premium", "swiggy-one"],
  );
  // Ties at zero must not be resolved by Array.sort's internals.
  const zeros = result.verdicts.filter((v) => v.zombieScore === 0);
  assert.deepStrictEqual(
    rankVerdicts(zeros).map((v) => v.merchantKey),
    rankVerdicts([...zeros].reverse()).map((v) => v.merchantKey),
  );
});

check("DET: analyze is pure -- same input, byte-identical output", () => {
  const fixture = demoFixture();
  assert.deepStrictEqual(analyze(fixture, ASOF), analyze(fixture, ASOF));
});

check("DET: the result does not depend on input order", () => {
  const fixture = demoFixture();
  const shuffled = [...fixture].sort((a, b) => (a.id < b.id ? 1 : -1));
  assert.deepStrictEqual(analyze(shuffled, ASOF), analyze(fixture, ASOF));
});

check("DET: the answer is pinned to asOf, not to the system clock", () => {
  // Hard-coded expectations, deliberately not recomputed from the fixture --
  // a test that recomputes its own expectation cannot catch a scoring change.
  const result = analyze(demoFixture(), ASOF);
  assert.strictEqual(result.asOf, ASOF);
  assert.strictEqual(result.subscriptions.length, 5, "no phantom sixth subscription");
  assert.strictEqual(verdictFor(result, "amazon-prime").zombieScore, 2093);
  assert.strictEqual(verdictFor(result, "zomato-gold").zombieScore, 800);
  assert.strictEqual(verdictFor(result, "swiggy-one").zombieScore, 0);
  assert.strictEqual(verdictFor(result, "swiggy-one").verdict, "used");
  assert.strictEqual(result.totalWasted, 2893);
  assert.strictEqual(result.annualSavings, 5988);
});

check("SPAN: the result reports how much history it actually analysed", () => {
  // These figures go on screen, so they are computed and pinned in the engine
  // rather than derived in a component. The dashboard previously stated neither,
  // which is why "how many months are we tracking?" had no answer on the page.
  const result = analyze(demoFixture(), ASOF);
  assert.strictEqual(result.historyStart, ago(220), "earliest charge in the fixture");
  assert.strictEqual(result.historySpanDays, 220);
  assert.strictEqual(result.transactionsAnalysed, demoFixture().length);
  // The two windows are different spans, and that is the whole point.
  assert.strictEqual(result.lookbackDays, 90);
  assert.ok(result.historySpanDays > result.lookbackDays);
});

check("SPAN: an empty history reports null rather than a misleading zero date", () => {
  const result = analyze([], ASOF);
  assert.strictEqual(result.historyStart, null);
  assert.strictEqual(result.historySpanDays, 0);
  assert.strictEqual(result.transactionsAnalysed, 0);
  assert.strictEqual(result.lookbackDays, 90, "no data does not shrink the window");
});

check("SPAN: the span excludes rows beyond the asOf horizon", () => {
  const result = analyze([...demoFixture(), t("FUTURE", -60, 500)], ASOF);
  assert.strictEqual(result.historySpanDays, 220, "a future-dated row must not widen the span");
  assert.strictEqual(result.transactionsAnalysed, demoFixture().length);
});

check("SPAN: each subscription reports its own chain span", () => {
  const result = analyze(demoFixture(), ASOF);
  const prime = result.subscriptions.find((s) => s.merchantKey === "amazon-prime");
  assert.ok(prime);
  assert.strictEqual(prime.spanDays, 180, "7 charges at 30-day cadence");
  assert.strictEqual(prime.spanDays, 180);
  const zomato = result.subscriptions.find((s) => s.merchantKey === "zomato-gold");
  assert.ok(zomato);
  assert.strictEqual(zomato.spanDays, 210, "8 charges at 30-day cadence");
});

check("SPAN: a short history shrinks the window but not the reported span", () => {
  const result = analyze([0, 31, 62].map((d) => t("AMAZON PRIME", d, 299)), ASOF);
  assert.strictEqual(result.historySpanDays, 62);
  assert.strictEqual(result.lookbackDays, 62, "the window cannot exceed the history");
  assert.strictEqual(verdictFor(result, "amazon-prime").confidence, "medium");
});

check("DET: rewinding asOf gives the historically correct answer", () => {
  // The time machine. As of 150 days ago, Zomato was still being used.
  const rewound = analyze(demoFixture(), ago(150));
  const zomato = rewound.verdicts.find((v) => v.merchantKey === "zomato-gold");
  assert.ok(zomato);
  assert.strictEqual(zomato.verdict, "used");
  assert.strictEqual(zomato.zombieScore, 0);
});

// ---------------------------------------------------------------------------
// The seeded demo history -- PLAN.md's table, reproduced from generated data
//
// These are the numbers that appear on stage. Everything above tests the engine
// against hand-written fixtures; these test the actual dataset the demo runs on.
// ---------------------------------------------------------------------------

check("SEED: the generated history is realistic in shape", () => {
  const seeded = buildSeedTransactions({ asOf: ASOF });
  const background = seeded.filter((r) => r.category !== "Subscriptions");
  assert.ok(
    background.length >= 40 && background.length <= 70,
    `expected 40-70 background rows, got ${background.length}`,
  );
  assert.ok(
    new Set(seeded.map((r) => r.id)).size === seeded.length,
    "seed ids must be unique",
  );
  assert.ok(
    seeded.every((r) => r.date <= ASOF),
    "no seeded row may be dated in the future",
  );
});

check("SEED: not one background merchant matches Amazon", () => {
  // A single stray Amazon row flips Prime to used, deletes 2093 rupees, and
  // takes the third demo beat with it -- silently. The donor seed has four.
  const stray = buildSeedTransactions({ asOf: ASOF }).filter(
    (r) =>
      r.merchant.toUpperCase() !== "AMAZON PRIME" &&
      matchesPattern(tokenize(r.merchant), "amazon"),
  );
  assert.deepStrictEqual(stray.map((r) => r.merchant), []);
});

check("SEED: exactly five subscriptions -- no phantom sixth from the noise", () => {
  const result = analyze(buildSeedTransactions({ asOf: ASOF }), ASOF);
  assert.strictEqual(
    result.subscriptions.length,
    EXPECTED_SEED_OUTCOME.subscriptionCount,
    `detected: ${result.subscriptions.map((s) => s.merchantKey).join(", ")}`,
  );
});

check("SEED: every planted verdict matches PLAN.md's table", () => {
  const result = analyze(buildSeedTransactions({ asOf: ASOF }), ASOF);
  assert.deepStrictEqual(
    result.verdicts.map((v) => ({
      merchantKey: v.merchantKey,
      verdict: v.verdict,
      confidence: v.confidence,
      zombieScore: v.zombieScore,
    })),
    EXPECTED_SEED_OUTCOME.verdicts.map((v) => ({ ...v })),
  );
});

check("SEED: the headline figures land", () => {
  const result = analyze(buildSeedTransactions({ asOf: ASOF }), ASOF);
  assert.strictEqual(result.totalWasted, EXPECTED_SEED_OUTCOME.totalWasted);
  assert.strictEqual(result.annualSavings, EXPECTED_SEED_OUTCOME.annualSavings);
});

check("SEED: Amazon Prime traces to 7 charges starting in January", () => {
  const result = analyze(buildSeedTransactions({ asOf: ASOF }), ASOF);
  const prime = verdictFor(result, "amazon-prime");
  assert.strictEqual(prime.wastedCharges.length, 7);
  assert.strictEqual(prime.evidence.firstDate, "2026-01-24");
  assert.strictEqual(
    prime.zombieScore,
    round2(prime.wastedCharges.reduce((s, c) => s + c.amount, 0)),
  );
});

check("SEED: Zomato Gold wastes exactly 4 of its 8 charges", () => {
  const result = analyze(buildSeedTransactions({ asOf: ASOF }), ASOF);
  const zomato = verdictFor(result, "zomato-gold");
  assert.strictEqual(zomato.evidence.chargeCount, 8);
  assert.strictEqual(zomato.wastedCharges.length, 4);
  assert.strictEqual(zomato.evidence.daysSinceLastUsage, 115);
  assert.strictEqual(zomato.zombieScore, 800);
});

check("SEED: answering no to Netflix moves the headline as rehearsed", () => {
  // Demo beat 5. The figures jump because the user supplied the evidence the
  // agent admitted it lacked -- worth rehearsing so it is not a surprise.
  const seeded = buildSeedTransactions({ asOf: ASOF });
  const answered = analyze(seeded, ASOF, {
    answers: [{ merchantKey: "netflix", used: false, answeredAt: `${ASOF}T10:00:00Z` }],
  });
  assert.strictEqual(answered.totalWasted, 6787, "2893 + 3894");
  assert.strictEqual(answered.annualSavings, 13776, "12 x (299 + 200 + 649)");
  assert.deepStrictEqual(answered.needsInput.map((v) => v.merchantKey), ["kuku-fm-premium"]);
});

check("SEED: the demo does not rot -- the figures hold at any anchor date", () => {
  // Dates are generated relative to asOf, so seeding in November must give the
  // same answer as seeding today. This is the check that keeps the fixtures
  // from going stale between now and the submission.
  for (const anchor of ["2026-08-04", "2026-08-08", "2026-11-30", "2027-03-01"]) {
    const result = analyze(buildSeedTransactions({ asOf: anchor }), anchor);
    assert.strictEqual(result.totalWasted, 2893, `totalWasted drifted at ${anchor}`);
    assert.strictEqual(result.annualSavings, 5988, `annualSavings drifted at ${anchor}`);
    assert.strictEqual(result.subscriptions.length, 5, `subscription count drifted at ${anchor}`);
    // The reported span must be as stable as the money, since it is now shown
    // on screen next to it.
    assert.strictEqual(result.historySpanDays, 220, `history span drifted at ${anchor}`);
    assert.strictEqual(result.lookbackDays, 90, `lookback drifted at ${anchor}`);
  }
});

// ---------------------------------------------------------------------------
// The proposal guard -- an LLM must not be able to invent a rupee figure
// ---------------------------------------------------------------------------

function seedProposalInput() {
  return buildProposalInput(analyze(buildSeedTransactions({ asOf: ASOF }), ASOF));
}

check("PLAN: figures come from the engine, and the action is decided in code", () => {
  const input = seedProposalInput();
  assert.strictEqual(input.totalWasted, 2893);
  assert.strictEqual(input.annualSavings, 5988);
  assert.deepStrictEqual(
    input.findings.map((f) => [f.merchantKey, f.suggestedAction]),
    [
      ["amazon-prime", "cancel"],
      ["zomato-gold", "cancel"],
      ["netflix", "check"],
      ["kuku-fm-premium", "check"],
      ["swiggy-one", "keep"],
    ],
  );
});

check("PLAN: an invented figure is detected", () => {
  const allowed = allowedNumbers(seedProposalInput());
  // Real figures pass, with or without Indian digit grouping.
  assert.deepStrictEqual(foreignNumbers("You have wasted ₹2,893 so far.", allowed), []);
  assert.deepStrictEqual(foreignNumbers("Cancelling saves ₹5988 a year.", allowed), []);
  // A plausible-looking total that was never supplied does not.
  assert.deepStrictEqual(foreignNumbers("You could save ₹7,450 a year!", allowed), ["7,450"]);
});

check("PLAN: small counts are allowed so the guard is not switched off in frustration", () => {
  const allowed = allowedNumbers(seedProposalInput());
  assert.deepStrictEqual(foreignNumbers("3 of your 5 subscriptions, over 12 months.", allowed), []);
});

check("PLAN: one bad number discards the whole plan, not just the sentence", () => {
  const input = seedProposalInput();
  const good = templatePlan(input);
  assert.strictEqual(planIsGrounded(good, input), true);

  assert.strictEqual(
    planIsGrounded({ ...good, summary: "You are wasting ₹9,999 a year." }, input),
    false,
    "an invented figure in the summary must sink the plan",
  );
  assert.strictEqual(
    planIsGrounded(
      {
        ...good,
        items: good.items.map((i, idx) =>
          idx === 0 ? { ...i, rationale: "This has cost you ₹4,321." } : i,
        ),
      },
      input,
    ),
    false,
    "an invented figure in any rationale must sink the plan",
  );
});

check("PLAN: the deterministic fallback reproduces the engine's figures exactly", () => {
  // This plan is the floor the feature stands on, which is why discarding
  // Gemini's output costs nothing.
  const input = seedProposalInput();
  const plan = templatePlan(input);
  assert.ok(plan.summary.includes("5,988"), `annual savings missing: ${plan.summary}`);
  assert.ok(plan.summary.includes("2,893"), `total wasted missing: ${plan.summary}`);
  assert.strictEqual(plan.items.length, 5);
  assert.strictEqual(planIsGrounded(plan, input), true);
});

// ---------------------------------------------------------------------------

const total = passes.length + failures.length;
if (failures.length > 0) {
  console.error(`\n${failures.length} of ${total} checks FAILED\n`);
  for (const f of failures) {
    console.error(`  x ${f.name}\n    ${f.error.split("\n")[0]}\n`);
  }
  process.exit(1);
}
for (const name of passes) console.log(`  ok  ${name}`);
console.log(`\n${total} checks passed.`);
