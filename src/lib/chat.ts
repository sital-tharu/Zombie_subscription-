/**
 * The assistant, and the reason it cannot lie about money.
 *
 * Every question a person actually asks this app is a money question -- "how
 * much did I waste", "what am I paying" -- so a chatbot is the single most
 * dangerous place to put a language model in this product. CLAUDE.md's rule is
 * categorical: an LLM that invents a savings figure is worse than useless here.
 *
 * The donor project shows the failure mode. Its chat drops two hundred receipts
 * into the prompt and asks a flash-lite model to do arithmetic over a
 * pipe-delimited table, with no validation of the reply at all. A wrong total
 * renders identically to a right one, and nobody -- least of all the user --
 * can tell which they got.
 *
 * So the split here is the same one the rest of the app uses. CODE computes
 * every figure, before Gemini is called. Gemini is handed those figures and
 * asked only for sentences. Then `foreignNumbers` sweeps the reply, and a
 * single digit that was not supplied discards the WHOLE answer -- not the
 * offending sentence, because a model that invented one figure has not earned
 * trust for the rest of the paragraph.
 *
 * That makes this the fourth enforcement of "Gemini never produces a number",
 * beside the ESLint engine boundary, the numberless proposal schema, and the
 * plan's own grounding scan. It is also why the fallback below is not a
 * degraded mode: the deterministic answer is the floor the whole feature stands
 * on, and refusing Gemini's output costs the user nothing.
 */
import { inr, monthLabel } from "./format";
import { foreignNumbers } from "./proposal";
import type { AnalyzeResult } from "./types";

/** Longest question accepted. Matches the input's maxLength. */
export const MAX_QUESTION_CHARS = 300;

/** Everything the assistant is allowed to know, and therefore to say. */
export interface ChatContext {
  asOf: string;
  monthLabel: string;
  lookbackDays: number;
  totalWasted: number;
  annualSavings: number;
  monthlyRunRate: number;
  savedAnnual: number;
  transactionCount: number;
  subscriptions: {
    merchant: string;
    monthlyAmount: number;
    verdict: string;
    confidence: string;
    zombieScore: number;
    potentialWaste: number;
    status: string;
    cancelled: boolean;
    reason: string;
    sinceDate: string;
    chargeCount: number;
    totalPaid: number;
  }[];
}

export function buildChatContext(
  result: AnalyzeResult,
  transactionCount: number,
): ChatContext {
  return {
    asOf: result.asOf,
    monthLabel: monthLabel(result.asOf),
    lookbackDays: result.lookbackDays,
    totalWasted: result.totalWasted,
    annualSavings: result.annualSavings,
    monthlyRunRate: result.monthlyRunRate,
    savedAnnual:
      12 *
      result.verdicts
        .filter((v) => v.status === "ended" && v.cancellation)
        .reduce((sum, v) => sum + v.monthlyAmount, 0),
    transactionCount,
    subscriptions: result.verdicts.map((v) => ({
      merchant: v.merchant,
      monthlyAmount: v.monthlyAmount,
      verdict: v.verdict,
      confidence: v.confidence,
      zombieScore: v.zombieScore,
      potentialWaste: v.potentialWaste,
      status: v.status,
      cancelled: v.cancellation !== undefined,
      reason: v.reason,
      sinceDate: v.evidence.firstDate,
      chargeCount: v.evidence.chargeCount,
      totalPaid: v.evidence.totalPaid,
    })),
  };
}

/**
 * Every number the assistant may write, as normalised strings.
 *
 * Mirrors `allowedNumbers` in proposal.ts deliberately -- one guard, applied
 * twice, is easier to keep correct than two that drift. Integers up to 31 pass
 * unconditionally: counts, day numbers and "3 subscriptions" are ordinary prose
 * and cannot be mistaken for a currency claim, and a guard that fires on them
 * would fire constantly and therefore be switched off.
 */
export function chatAllowedNumbers(ctx: ChatContext): Set<string> {
  const allowed = new Set<string>();
  const add = (n: number) => {
    allowed.add(String(n));
    allowed.add(String(Math.round(n)));
  };

  for (let i = 0; i <= 31; i++) allowed.add(String(i));
  add(ctx.totalWasted);
  add(ctx.annualSavings);
  add(ctx.monthlyRunRate);
  add(ctx.savedAnnual);
  add(ctx.lookbackDays);
  add(ctx.transactionCount);
  for (const part of ctx.asOf.split("-")) allowed.add(String(Number(part)));

  for (const s of ctx.subscriptions) {
    add(s.monthlyAmount);
    add(s.monthlyAmount * 12);
    add(s.zombieScore);
    add(s.potentialWaste);
    add(s.chargeCount);
    add(s.totalPaid);
    for (const part of s.sinceDate.split("-")) allowed.add(String(Number(part)));
    // Figures already quoted in the code-authored reason are fair game: the
    // model is shown that sentence and may repeat it.
    for (const match of s.reason.matchAll(/\d[\d,]*\.?\d*/g)) {
      allowed.add(match[0].replace(/,/g, ""));
    }
  }
  return allowed;
}

/** True when every number in `text` traces back to something we supplied. */
export function answerIsGrounded(text: string, ctx: ChatContext): boolean {
  return foreignNumbers(text, chatAllowedNumbers(ctx)).length === 0;
}

const REFUSAL =
  "I can only answer questions about the subscriptions and transactions on this " +
  "dashboard — what you are paying for, which ones look unused, and what that has " +
  "cost you.";

export { REFUSAL };

/**
 * A code-authored answer for the questions people actually ask.
 *
 * Not a fallback bolted on afterwards: this is what ships whenever Gemini's
 * reply cannot be trusted, and what ships when there is no Gemini key at all.
 * Keyword matching is crude on purpose -- it only has to catch the common
 * shapes, because anything it misses still goes through the grounding guard.
 */
export function deterministicAnswer(ctx: ChatContext, question: string): string | null {
  const q = question.toLowerCase();
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  const zombies = ctx.subscriptions
    .filter((s) => s.verdict === "likely-unused")
    .sort((a, b) => b.zombieScore - a.zombieScore);
  const unknowns = ctx.subscriptions.filter((s) => s.verdict === "unknown");
  const active = ctx.subscriptions.filter((s) => s.status === "active");

  // "What is a zombie subscription?" -- definitional, no figures involved.
  if (has("what is a zombie", "what's a zombie", "what are zombie", "define")) {
    return (
      "A zombie subscription is one you are still paying for but no longer using. " +
      "This app judges that from evidence rather than from the charge itself: for a " +
      "service like Amazon Prime it looks for Amazon orders, and if none appear in " +
      `the last ${ctx.lookbackDays} days it counts the charges billed since you last ` +
      "used it. Services that leave no trace when used, like Netflix, are never " +
      "guessed at — it asks you instead."
    );
  }

  if (has("waste", "wasted", "wasting", "losing", "lost")) {
    if (zombies.length === 0) {
      return "Nothing looks wasted right now — none of your subscriptions is flagged as unused.";
    }
    const worst = zombies
      .slice(0, 3)
      .map((s) => `${s.merchant} ${inr(s.zombieScore)}`)
      .join(", ");
    return (
      `${inr(ctx.totalWasted)} so far, across ${zombies.length} ` +
      `${zombies.length === 1 ? "subscription" : "subscriptions"}: ${worst}. ` +
      `That is money billed since the last time each one showed any sign of use, ` +
      `and every rupee of it traces to a real charge you can open on the dashboard.`
    );
  }

  if (has("save", "saving", "savings", "cancel")) {
    if (ctx.annualSavings === 0) {
      return ctx.savedAnnual > 0
        ? `You have already saved ${inr(ctx.savedAnnual)} a year by cancelling. Nothing else is currently flagged.`
        : "Nothing is currently flagged for cancelling, so there is no saving to claim.";
    }
    return (
      `Cancelling everything currently flagged would stop ${inr(ctx.annualSavings)} a year. ` +
      `Nothing is cancelled for you — the plan gives you a checklist and you tick items off ` +
      `as you actually cancel them.`
    );
  }

  if (has("summary", "how many", "list", "what am i paying", "subscriptions do i", "overview")) {
    if (ctx.subscriptions.length === 0) {
      return "No recurring subscriptions detected yet. A charge becomes one after three payments about a month apart at a similar amount.";
    }
    const lines = ctx.subscriptions
      .map((s) => {
        const tag =
          s.cancelled ? "cancelled"
          : s.verdict === "likely-unused" ? `unused, ${inr(s.zombieScore)} wasted`
          : s.verdict === "unknown" ? "can't tell"
          : "used";
        return `${s.merchant} ${inr(s.monthlyAmount)}/mo (${tag})`;
      })
      .join("; ");
    return (
      `${ctx.monthLabel}: ${active.length} active ` +
      `${active.length === 1 ? "subscription" : "subscriptions"} costing ` +
      `${inr(ctx.monthlyRunRate)} a month. ${lines}.` +
      (unknowns.length > 0
        ? ` ${unknowns.length} of them leave no trace when used, so they are waiting on your answer.`
        : "")
    );
  }

  if (has("unused", "zombie", "unsubscribe", "which one")) {
    if (zombies.length === 0) return "None of your subscriptions currently looks unused.";
    return zombies
      .map((s) => `${s.merchant} — ${s.reason}`)
      .join(" ");
  }

  return null;
}

export function buildChatPrompt(ctx: ChatContext, question: string): string {
  const rows = ctx.subscriptions
    .map((s) =>
      [
        `- ${s.merchant}`,
        `  costs ${inr(s.monthlyAmount)} per month, billed ${s.chargeCount} times since ${s.sinceDate}, ${inr(s.totalPaid)} in total`,
        `  verdict: ${s.verdict} (${s.confidence} confidence)${s.cancelled ? ", user has cancelled it" : ""}`,
        s.zombieScore > 0 ? `  wasted so far: ${inr(s.zombieScore)}` : null,
        s.potentialWaste > 0 ? `  at stake if unused: ${inr(s.potentialWaste)}` : null,
        `  our finding: ${s.reason}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

  return [
    "You are the assistant inside Zombie, an app that finds subscriptions someone",
    "pays for but no longer uses. Be friendly, concise and supportive.",
    "",
    "ABSOLUTE RULE: do not calculate, estimate, total, or introduce ANY number that",
    "is not written below. Reproduce the ones you use exactly as given. If you want",
    "to mention an amount you have not been given, describe it in words instead. A",
    "reply containing an unfamiliar number is discarded and the user sees a",
    "different answer, so guessing helps nobody.",
    "",
    "Also:",
    "- 1 to 4 short sentences. Plain text only: no markdown, no bullets, no headings.",
    "- Answer ONLY from the data below. If it cannot answer the question, say so.",
    "- Politely decline anything not about these subscriptions or transactions.",
    "- Never claim to have cancelled anything. This app never cancels for the user.",
    "",
    `Today is ${ctx.asOf}. Usage is judged over the last ${ctx.lookbackDays} days.`,
    `Wasted to date: ${inr(ctx.totalWasted)}`,
    `Would be saved per year by cancelling everything flagged: ${inr(ctx.annualSavings)}`,
    `Current monthly cost of active subscriptions: ${inr(ctx.monthlyRunRate)}`,
    `Already saved per year by cancelling: ${inr(ctx.savedAnnual)}`,
    `Transactions analysed: ${ctx.transactionCount}`,
    "",
    "SUBSCRIPTIONS:",
    rows || "- none detected yet",
    "",
    `QUESTION: ${question}`,
  ].join("\n");
}
