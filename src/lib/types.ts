/**
 * Engine types. This file imports nothing, on purpose.
 *
 * The verdict engine (Layers 1-3) has to run under `npm run test:logic` with no
 * Firestore and no Gemini credentials. The donor project made the opposite
 * choice -- it derived its core types from Zod schemas -- and that single
 * decision is what made its detection logic impossible to lift. Zod lives in
 * schemas.ts and validates at the API boundary; by the time data reaches these
 * types it is already plain data.
 */

/**
 * The engine's entire view of a transaction. Structural: anything carrying
 * these four fields qualifies, including StoredTransaction from the data layer.
 *
 * The omission of `category` is deliberate. Category is assigned by Gemini
 * during extraction, and no LLM output may sit in the path of a number. The
 * engine must never read it, so it isn't offered here.
 */
export interface TransactionLike {
  id: string;
  /** Raw UPI payee string, e.g. "RAZORPAY*ZOMATO GOLD". Normalised on read. */
  merchant: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Rupees, positive. */
  total: number;
}

/** A transaction as persisted. Still framework-free; its Zod schema is in schemas.ts. */
export interface StoredTransaction extends TransactionLike {
  category?: string;
  source?: TransactionSource;
  /** ISO timestamp. */
  createdAt?: string;
  /** Written by `npm run seed`, so demo rows can be wiped selectively. */
  seeded?: boolean;
}

export type TransactionSource = "photo" | "email" | "seed" | "manual";

/**
 * One charge, carried by value rather than by id alone so the UI can render a
 * complete evidence chain without re-joining against the transaction list.
 */
export interface ChargeRef {
  id: string;
  date: string;
  amount: number;
}

/** Layer 1 output: a detected recurring charge and its full chain. */
export interface Subscription {
  /** Stable slug. Doubles as the Firestore doc id for verdicts/{merchantKey}. */
  merchantKey: string;
  /** Display name -- the map's canonical name if mapped, else the latest raw payee. */
  merchant: string;
  /** The MOST RECENT charge amount, so price hikes flow through to annualSavings. */
  monthlyAmount: number;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  /** Sum over chain members only -- never the whole merchant group. */
  totalPaid: number;
  /** Ascending by (date, id). See the invariant note in correlate.ts. */
  chargeIds: string[];
  /** Same order as chargeIds; chargeIds === charges.map(c => c.id). */
  charges: ChargeRef[];
  /** Median gap between consecutive charges, for "billed roughly every 30 days". */
  cadenceDays: number;
  /** Relative to asOf. */
  daysSinceLastCharge: number;
  /** firstDate -> lastDate. How long this subscription has been running. */
  spanDays: number;
}

export type Verdict = "used" | "likely-unused" | "unknown";

/**
 * Confidence as a closed set of words. There is deliberately no numeric
 * confidence field anywhere in this file: PLAN.md forbids rendering confidence
 * as a percentage, because fake precision undercuts the honesty argument the
 * whole product rests on. The cheapest way to guarantee a number never reaches
 * the screen is to make it unrepresentable.
 */
export type Confidence = "high" | "medium" | "low" | "none" | "user-confirmed";

/**
 * Whether this service can be observed at all.
 * - "transaction": genuine use leaves a separate charge (Prime -> Amazon orders).
 * - "none":        recognised service, but it leaves no financial trace (Netflix).
 * - "unmapped":    merchant not in the map; we don't know what use would look like.
 *
 * "none" and "unmapped" both route to the Evidence Gap Handler, but they are not
 * the same claim, and the UI says so: one is "we know we can't see this", the
 * other is "we don't recognise this".
 */
export type Footprint = "transaction" | "none" | "unmapped";

/**
 * Everything behind a verdict, in the order a person would ask for it: what we
 * looked for, where we looked, what we found, and which charges the money
 * figure is made of.
 */
export interface EvidenceChain {
  footprint: Footprint;
  /** "Amazon orders". Null when there is nothing to search for. */
  usageLabel: string | null;
  /** Exactly the patterns searched, so the UI can show its working. */
  searchedPatterns: string[];
  /** 90, or fewer when the dataset itself is shorter -- see confidence "medium". */
  lookbackDays: number;
  windowStart: string;
  /** === asOf. */
  windowEnd: string;
  /** Usage inside the window. Drives the verdict. */
  matchesInWindow: ChargeRef[];
  /**
   * Most recent usage across ALL history, window or not. Drives the score.
   * Keeping this separate from matchesInWindow is load-bearing -- conflating
   * the two silently doubles the money figure. See correlate.ts.
   */
  lastUsage: ChargeRef | null;
  daysSinceLastUsage: number | null;
  /** The full charge chain, ascending. */
  charges: ChargeRef[];
  chargeCount: number;
  totalPaid: number;
  firstDate: string;
  lastDate: string;
  userAnswer?: { used: boolean; answeredAt: string };
}

export interface UsageVerdict {
  merchantKey: string;
  merchant: string;
  monthlyAmount: number;
  verdict: Verdict;
  confidence: Confidence;
  /** Rupees. Always === sum(wastedCharges.amount). Zero unless likely-unused. */
  zombieScore: number;
  /** The charges the score is literally made of. Every rupee traces to an id. */
  wastedCharges: ChargeRef[];
  /**
   * Rupees at risk if an unknown turns out to be unused. Zero unless unknown.
   * Shown beside the question; never rolled into the headline totals.
   */
  potentialWaste: number;
  /** Non-null iff verdict === "unknown". */
  question: string | null;
  /** Code-authored one-liner. Gemini never writes this. */
  reason: string;
  evidence: EvidenceChain;
}

export interface UserAnswer {
  merchantKey: string;
  used: boolean;
  /** ISO timestamp. */
  answeredAt: string;
}

export interface AnalyzeResult {
  asOf: string;
  /**
   * How far back usage is checked. NOT how far back charges are read -- charge
   * history is unbounded. Keeping both on the result is what lets the UI state
   * the difference instead of leaving it to be explained out loud.
   */
  lookbackDays: number;
  /** Earliest transaction analysed. Null when there is no history at all. */
  historyStart: string | null;
  /** historyStart -> asOf. The full period the charge chains were drawn from. */
  historySpanDays: number;
  /** Rows that survived validation and the asOf horizon. */
  transactionsAnalysed: number;
  subscriptions: Subscription[];
  /** Ranked by zombieScore desc, then a total order so ties are never arbitrary. */
  verdicts: UsageVerdict[];
  totalWasted: number;
  annualSavings: number;
  /** Subset of verdicts: unanswered unknowns, ranked by potentialWaste desc. */
  needsInput: UsageVerdict[];
}
