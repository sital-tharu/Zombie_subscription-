/**
 * Layers 2, 2c and 3: usage correlation, the evidence gap handler, and scoring.
 *
 * This is the product. Recurring-charge detection is solved and every bank app
 * ships it; deciding whether a subscription is actually *used* is not, and that
 * gap is the whole thesis.
 *
 * Two invariants hold everything else up:
 *
 *   1. zombieScore is the SUM OF ACTUAL CHARGES billed after the last piece of
 *      usage evidence. Its unit is rupees and every rupee carries a transaction
 *      id, so the headline reconciles against the charge history by
 *      construction rather than by trust. It is not an estimate.
 *
 *   2. No evidence means no claim. A subscription we cannot observe scores
 *      exactly zero and asks the user a question instead of guessing.
 */
import { addDaysIso, daysBetween, round2 } from "./dates";
import {
  isEmailUsageEvidence,
  isSubscriptionCharge,
  lookupByKey,
  matchesPattern,
  tokenize,
  type MerchantEntry,
} from "./merchant-map";
import {
  detectSubscriptions,
  hasEnded,
  nextChargeDate,
  resolveAsOf,
  withinHorizon,
} from "./subscriptions";
import type {
  AnalyzeResult,
  Cancellation,
  ChargeRef,
  Confidence,
  EmailEvent,
  EvidenceChain,
  Subscription,
  TransactionLike,
  UsageVerdict,
  UserAnswer,
  Verdict,
} from "./types";

/** Correlation lookback. A subscription with no activity across it is flagged. */
export const LOOKBACK_DAYS = 90;

export interface AnalyzeOptions {
  /** Persisted gap-handler answers. Always outrank inference. */
  answers?: readonly UserAnswer[];
  /** Subscriptions the user has declared cancelled. */
  cancellations?: readonly Cancellation[];
  /**
   * Layer 2b. Message headers synced from Gmail, which extend usage detection
   * to spending this app never sees -- a Swiggy order paid by card, an Amazon
   * purchase on a saved wallet. Without them such usage looks like silence, and
   * silence is what this engine calls a zombie. A false zombie is the worst
   * failure this product has, so this is a correctness feature before it is a
   * coverage one.
   */
  emails?: readonly EmailEvent[];
  /** Tests only. Production always uses LOOKBACK_DAYS. */
  lookbackDays?: number;
}

/**
 * Is this transaction evidence that `entry` is being used?
 *
 * The ORDER OF THESE STEPS IS THE CONTRACT. Reordering or narrowing any of them
 * reintroduces the self-validation trap, and the trap fails silently: every
 * subscription cites its own bill as proof of use, every verdict comes back
 * "used", and the app reports zero zombies with no error at all.
 */
export function isUsageEvidence(
  txn: TransactionLike,
  entry: MerchantEntry,
  excludedIds: ReadonlySet<string>,
): boolean {
  // 1. Belt: this exact transaction is one of THIS subscription's own charges.
  if (excludedIds.has(txn.id)) return false;

  // 2. Nothing is evidence for a service that leaves no footprint. Watching
  //    Netflix costs nothing extra, so silence is the expected state and any
  //    "match" would be a coincidence.
  if (entry.footprint === "none") return false;

  // 3. Braces: does this look like ANY subscription charge in the map? The
  //    global scope is the subtle half. Consider an Amazon Prime charge that
  //    Layer 1 failed to chain -- only two occurrences, or a broken cadence. It
  //    is not in excludedIds, so step 1 lets it through, and this step is the
  //    only thing between it and a "used" verdict for Prime. Narrowing this to
  //    entry.subscriptionPatterns would happen to work for Prime but would let
  //    an "Amazon Music" charge validate Prime instead.
  if (isSubscriptionCharge(txn.merchant)) return false;

  // 4. Finally, does it match what use of THIS service looks like?
  const tokens = tokenize(txn.merchant);
  return entry.usagePatterns.some((pattern) => matchesPattern(tokens, pattern));
}

/**
 * Run the full pipeline.
 *
 * `asOf` is injectable so tests and demos are deterministic; it defaults to
 * today. `opts.answers` is applied here rather than by the caller, because a
 * caller who forgets to apply them produces a screen where the user's answer
 * silently fails to stick.
 */
export function analyze(
  transactions: readonly TransactionLike[],
  asOf?: string,
  opts?: AnalyzeOptions,
): AnalyzeResult {
  const asOfDate = resolveAsOf(asOf);
  const txns = withinHorizon(transactions, asOfDate);
  const subscriptions = detectSubscriptions(txns, asOfDate);

  // One scan, two consumers: the reported history span and the lookback ceiling
  // below. Computing the earliest date twice would let the figure shown on
  // screen drift from the one the confidence grade depends on.
  const historyStart = earliestDate(txns);
  const historySpanDays = historyStart ? daysBetween(historyStart, asOfDate) : 0;

  const requested = opts?.lookbackDays ?? LOOKBACK_DAYS;
  const lookbackDays = historyStart
    ? Math.max(0, Math.min(requested, historySpanDays))
    : requested;
  const windowStart = addDaysIso(asOfDate, -lookbackDays);

  const answersByKey = new Map(
    (opts?.answers ?? []).map((a) => [a.merchantKey, a]),
  );

  // Only cancellations that had already happened by `asOf`. Paging the
  // dashboard back to April must show a subscription cancelled in August as
  // still running, exactly as it was.
  const cancellationsByKey = new Map(
    (opts?.cancellations ?? [])
      .filter((c) => c.cancelledAt <= asOfDate)
      .map((c) => [c.merchantKey, c]),
  );

  const verdicts = subscriptions.map((sub) => {
    // Scoped to this subscription's OWN charges, deliberately not to every
    // detected chain. Global id-exclusion looks safer and is not: three
    // similar monthly Amazon purchases chain into their own "amazon"
    // subscription, and excluding them by id would strike genuine Amazon
    // activity from Amazon Prime's evidence and flag an actively used Prime as
    // a zombie. A false zombie is the worst failure this product has.
    //
    // Nothing is lost. Every MAPPED subscription's charges are already caught
    // by step 3 of isUsageEvidence, which matches subscription patterns across
    // the whole map. The only charges this narrowing lets back in are unmapped
    // recurring ones -- and for those, counting them is usually right: a
    // monthly "AMAZON PANTRY" charge genuinely is Amazon usage.
    const base = judge(
      sub,
      txns,
      new Set(sub.chargeIds),
      { asOf: asOfDate, windowStart, lookbackDays },
      opts?.emails ?? [],
    );
    const answer = answersByKey.get(sub.merchantKey);
    const answered = answer ? applyUserAnswer(base, answer) : base;
    const cancellation = cancellationsByKey.get(sub.merchantKey);
    return cancellation ? applyCancellation(answered, cancellation) : answered;
  });

  const ranked = rankVerdicts(verdicts);

  return {
    asOf: asOfDate,
    lookbackDays,
    historyStart,
    historySpanDays,
    transactionsAnalysed: txns.length,
    subscriptions,
    verdicts: ranked,
    // Every ACTIVE subscription counts toward what you pay, including the ones
    // we decline to judge. Filtering unknowns out here would understate the
    // bill for exactly the services the user is least sure about; leaving
    // ended ones in would bill them for something they already cancelled.
    monthlyRunRate: round2(
      ranked
        .filter((v) => v.status === "active")
        .reduce((sum, v) => sum + v.monthlyAmount, 0),
    ),
    totalWasted: round2(ranked.reduce((sum, v) => sum + v.zombieScore, 0)),
    // Only likely-unused contributes. Unanswered unknowns are worth exactly
    // nothing here, on purpose -- that is the honesty thesis as arithmetic.
    //
    // And only ACTIVE ones: a subscription that stopped billing in March
    // cannot be cancelled again, so promising twelve more months of savings on
    // it would be inventing money. Its zombieScore is untouched -- that waste
    // genuinely happened.
    annualSavings: round2(
      12 *
        ranked
          .filter((v) => v.verdict === "likely-unused" && v.status === "active")
          .reduce((sum, v) => sum + v.monthlyAmount, 0),
    ),
    needsInput: ranked
      .filter((v) => v.verdict === "unknown" && v.evidence.userAnswer === undefined)
      .sort(
        (a, b) =>
          b.potentialWaste - a.potentialWaste ||
          (a.merchantKey < b.merchantKey ? -1 : 1),
      ),
  };
}

/**
 * Earliest transaction date, or null for an empty history.
 *
 * This single figure drives two things that must never disagree: the history
 * span the dashboard reports, and the ceiling on the usage window. With only
 * 62 days of data, "no activity in 90 days" is a claim the data cannot support,
 * so the window shrinks to 62 and confidence drops to medium -- the only honest
 * source of MEDIUM in P0, since the PRD reserves it for the P1 email ratio.
 */
function earliestDate(txns: readonly TransactionLike[]): string | null {
  if (txns.length === 0) return null;
  return txns.reduce((min, t) => (t.date < min ? t.date : min), txns[0].date);
}

interface Window {
  asOf: string;
  windowStart: string;
  lookbackDays: number;
}

function judge(
  sub: Subscription,
  txns: readonly TransactionLike[],
  excludedIds: ReadonlySet<string>,
  win: Window,
  emails: readonly EmailEvent[],
): UsageVerdict {
  const entry = lookupByKey(sub.merchantKey);

  // --- Layer 2c: the evidence gap handler -------------------------------
  //
  // Two different kinds of not-knowing, kept apart because they are not the
  // same admission. "We recognise Netflix and know we cannot observe it" is a
  // stronger position than "we have never seen this merchant before", and the
  // confidence grade says so.
  if (entry === undefined) {
    return gapVerdict(sub, win, {
      footprint: "unmapped",
      confidence: "none",
      question: `Have you used ${sub.merchant} in the last ${win.lookbackDays} days?`,
      reason: `${sub.merchant} is not a merchant we recognise, so we do not know what using it would look like in your transactions.`,
    });
  }

  if (entry.footprint === "none") {
    return gapVerdict(sub, win, {
      footprint: "none",
      confidence: "low",
      question: entry.question.replace("{days}", String(win.lookbackDays)),
      reason: `${entry.displayName} leaves no separate charge when you use it, so silence in your transactions is not evidence either way.`,
    });
  }

  // --- Layer 2: transaction correlation ---------------------------------
  const usage = txns
    .filter((t) => isUsageEvidence(t, entry, excludedIds))
    .map((t) => ({ id: t.id, date: t.date, amount: t.total }))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1));

  // These two are computed from DIFFERENT RANGES and must stay that way.
  //
  //   matchesInWindow -- the last `lookbackDays` only. Answers "is it used?"
  //   lastUsage       -- ALL history, unbounded. Answers "used when?"
  //
  // Zomato Gold is the case that separates them: the last order is ~115 days
  // ago, outside the window, so the verdict is likely-unused -- but the score
  // must be bounded by that order, not by the window. Compute lastUsage from
  // the window-filtered list instead and it comes back null, the never-used
  // branch fires, and the demo shows twice the real figure with no error and a
  // perfectly plausible evidence chain. This is the bug to guard hardest.
  const matchesInWindow = usage.filter((u) => u.date >= win.windowStart);
  const lastUsage = usage.length > 0 ? usage[usage.length - 1] : null;

  // --- Layer 2b: the same question, asked of the inbox --------------------
  //
  // Kept as its own list rather than merged into `usage`, because an email has
  // no amount and pretending otherwise would put a fabricated rupee figure into
  // a structure whose entire job is that every figure traces to a real one.
  //
  // The horizon applies here too: a message dated after `asOf` must be
  // invisible, or paging back through the months would show usage that had not
  // happened yet.
  const emailUsage = emails
    .filter((e) => e.date <= win.asOf && isEmailUsageEvidence(e, entry))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1));
  const emailMatchesInWindow = emailUsage.filter((e) => e.date >= win.windowStart);
  const lastEmailUsage = emailUsage.length > 0 ? emailUsage[emailUsage.length - 1] : null;

  // Either source proves use, and the score is bounded by whichever came last.
  // Taking only the transaction date would keep charging a subscription as
  // wasted for orders it can see proof of in the inbox.
  const usedInWindow = matchesInWindow.length + emailMatchesInWindow.length > 0;
  const lastUsageDate = [lastUsage?.date, lastEmailUsage?.date]
    .filter((d): d is string => typeof d === "string")
    .sort()
    .pop() ?? null;

  const evidence: EvidenceChain = {
    footprint: "transaction",
    usageLabel: entry.usageLabel,
    searchedPatterns: [...entry.usagePatterns],
    lookbackDays: win.lookbackDays,
    windowStart: win.windowStart,
    windowEnd: win.asOf,
    matchesInWindow,
    lastUsage,
    emailMatchesInWindow,
    lastEmailUsage,
    daysSinceLastUsage: lastUsageDate ? daysBetween(lastUsageDate, win.asOf) : null,
    charges: sub.charges,
    chargeCount: sub.occurrences,
    totalPaid: sub.totalPaid,
    firstDate: sub.firstDate,
    lastDate: sub.lastDate,
    spanDays: sub.spanDays,
    daysSinceLastCharge: sub.daysSinceLastCharge,
  };

  if (usedInWindow) {
    const mostRecentDate = [
      matchesInWindow[matchesInWindow.length - 1]?.date,
      emailMatchesInWindow[emailMatchesInWindow.length - 1]?.date,
    ]
      .filter((d): d is string => typeof d === "string")
      .sort()
      .pop()!;
    const found = [
      matchesInWindow.length > 0 && `${matchesInWindow.length} ${entry.usageLabel}`,
      emailMatchesInWindow.length > 0 &&
        `${emailMatchesInWindow.length} confirmation ${emailMatchesInWindow.length === 1 ? "email" : "emails"}`,
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      merchantKey: sub.merchantKey,
      merchant: sub.merchant,
      monthlyAmount: sub.monthlyAmount,
      nextCharge: nextChargeDate(sub),
      status: hasEnded(sub) ? "ended" : "active",
      verdict: "used",
      confidence: "high",
      // Zero, and not the literal sum-of-charges-after-last-use. That reading
      // would score an actively used subscription at a full month whenever the
      // latest charge happens to postdate the latest order by a few days. That
      // is not waste; it is the period you are paying for and using. A waste
      // claim is made only where a waste verdict is made.
      zombieScore: 0,
      wastedCharges: [],
      potentialWaste: 0,
      question: null,
      reason: `${found} in the last ${win.lookbackDays} days, most recently ${describeAge(daysBetween(mostRecentDate, win.asOf))}.`,
      evidence,
    };
  }

  const wastedCharges: ChargeRef[] = lastUsageDate
    ? // Strict >. A charge dated the same day as a usage event is not waste --
      // you used the service that day. Worth exactly one billing cycle on stage.
      sub.charges.filter((c) => c.date > lastUsageDate)
    : sub.charges;

  return {
    merchantKey: sub.merchantKey,
    merchant: sub.merchant,
    monthlyAmount: sub.monthlyAmount,
    nextCharge: nextChargeDate(sub),
    status: hasEnded(sub) ? "ended" : "active",
    verdict: "likely-unused",
    confidence: win.lookbackDays < LOOKBACK_DAYS ? "medium" : "high",
    zombieScore: round2(wastedCharges.reduce((sum, c) => sum + c.amount, 0)),
    wastedCharges,
    potentialWaste: 0,
    question: null,
    reason: lastUsageDate
      ? `Last sign of use was ${describeAge(daysBetween(lastUsageDate, win.asOf))}, outside the ${win.lookbackDays}-day window. ${wastedCharges.length} ${plural(wastedCharges.length, "charge")} billed since.`
      : `No ${entry.usageLabel} anywhere in your history${emails.length > 0 ? ", and nothing in your inbox either" : ""}. All ${sub.occurrences} ${plural(sub.occurrences, "charge")} are unmatched.`,
    evidence,
  };
}

function gapVerdict(
  sub: Subscription,
  win: Window,
  spec: {
    footprint: "none" | "unmapped";
    confidence: Confidence;
    question: string;
    reason: string;
  },
): UsageVerdict {
  return {
    merchantKey: sub.merchantKey,
    merchant: sub.merchant,
    monthlyAmount: sub.monthlyAmount,
    nextCharge: nextChargeDate(sub),
    status: hasEnded(sub) ? "ended" : "active",
    verdict: "unknown",
    confidence: spec.confidence,
    // No evidence means no claim. Zero, always.
    zombieScore: 0,
    wastedCharges: [],
    // What answering would be worth. Shown beside the question, never rolled
    // into the headline totals.
    potentialWaste: sub.totalPaid,
    question: spec.question,
    reason: spec.reason,
    evidence: {
      footprint: spec.footprint,
      usageLabel: null,
      searchedPatterns: [],
      lookbackDays: win.lookbackDays,
      windowStart: win.windowStart,
      windowEnd: win.asOf,
      matchesInWindow: [],
      lastUsage: null,
      emailMatchesInWindow: [],
      lastEmailUsage: null,
      daysSinceLastUsage: null,
      charges: sub.charges,
      chargeCount: sub.occurrences,
      totalPaid: sub.totalPaid,
      firstDate: sub.firstDate,
      lastDate: sub.lastDate,
      spanDays: sub.spanDays,
      daysSinceLastCharge: sub.daysSinceLastCharge,
    },
  };
}

/**
 * The user's answer outranks every inference, in both directions.
 *
 * A "no" prices the waste from the full charge chain: an unknown has no usage
 * evidence by construction, so if the user says they never used it, every
 * charge in the chain is waste.
 */
export function applyUserAnswer(
  verdict: UsageVerdict,
  answer: UserAnswer,
): UsageVerdict {
  const stamped: EvidenceChain = {
    ...verdict.evidence,
    userAnswer: { used: answer.used, answeredAt: answer.answeredAt },
  };

  if (answer.used) {
    return {
      ...verdict,
      verdict: "used",
      confidence: "user-confirmed",
      zombieScore: 0,
      wastedCharges: [],
      potentialWaste: 0,
      question: null,
      reason: `You confirmed you still use ${verdict.merchant}.`,
      evidence: stamped,
    };
  }

  return {
    ...verdict,
    verdict: "likely-unused",
    confidence: "user-confirmed",
    zombieScore: verdict.evidence.totalPaid,
    wastedCharges: verdict.evidence.charges,
    potentialWaste: 0,
    question: null,
    reason: `You confirmed you no longer use ${verdict.merchant}. All ${verdict.evidence.chargeCount} ${plural(verdict.evidence.chargeCount, "charge")} count as waste.`,
    evidence: stamped,
  };
}

/**
 * Apply a declared cancellation, and check whether it took.
 *
 * The declaration alone does not end anything -- a charge dated after it is
 * proof the subscription is still billing, whatever the user believed when they
 * accepted the plan. In that case `status` is left exactly as inference found
 * it, so the run rate keeps counting money that is genuinely still leaving the
 * account, and the UI has `chargedSince` to say so.
 *
 * This is what makes "you've saved 5,988 a year" safe to show the moment Accept
 * is pressed: the claim is not taken on trust, it is checked against the
 * transaction history on every single render.
 */
export function applyCancellation(
  verdict: UsageVerdict,
  cancellation: Cancellation,
): UsageVerdict {
  const chargedSince = verdict.evidence.charges.filter(
    (c) => c.date > cancellation.cancelledAt,
  );

  return {
    ...verdict,
    status: chargedSince.length > 0 ? verdict.status : "ended",
    cancellation: { cancelledAt: cancellation.cancelledAt, chargedSince },
  };
}

const VERDICT_RANK: Record<Verdict, number> = {
  "likely-unused": 0,
  unknown: 1,
  used: 2,
};

/**
 * Money wasted first, as CLAUDE.md requires. The rest of the comparator exists
 * because most verdicts tie at zero, and Array.sort must not be the thing
 * deciding the order of cards on a stage. Placing unknown between
 * likely-unused and used also puts the gap-handler cards adjacent.
 */
export function rankVerdicts(verdicts: readonly UsageVerdict[]): UsageVerdict[] {
  return [...verdicts].sort(
    (a, b) =>
      b.zombieScore - a.zombieScore ||
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      b.evidence.totalPaid - a.evidence.totalPaid ||
      (a.merchantKey < b.merchantKey ? -1 : a.merchantKey > b.merchantKey ? 1 : 0),
  );
}

function describeAge(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
