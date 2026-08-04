/**
 * Layer 3, final step: turning finished findings into language.
 *
 * Gemini's job here is narrow and worth stating precisely. It is handed every
 * figure, already computed, and asked only to write around them. It does not
 * decide what to cancel, does not compute a saving, and does not estimate
 * anything.
 *
 * Three independent guards, because "we told the model not to" is not a
 * control:
 *
 *   1. The response schema has no numeric field at all. There is nowhere for a
 *      number to arrive.
 *   2. Every string that comes back is scanned for numbers that were not in the
 *      input, and one unexplained figure discards the whole response.
 *   3. The templated plan is always available and is built from the same
 *      findings, so refusing Gemini's output costs the demo nothing.
 */
import { inr } from "./format";
import type { AnalyzeResult, UsageVerdict } from "./types";

export interface ProposalFinding {
  merchantKey: string;
  merchant: string;
  verdict: string;
  confidence: string;
  monthlyAmount: number;
  zombieScore: number;
  chargeCount: number;
  totalPaid: number;
  reason: string;
  suggestedAction: ProposalAction;
}

export type ProposalAction = "cancel" | "downgrade" | "keep" | "check";

export interface ProposalInput {
  asOf: string;
  lookbackDays: number;
  totalWasted: number;
  annualSavings: number;
  findings: ProposalFinding[];
}

export interface PlanText {
  summary: string;
  items: { merchantKey: string; action: ProposalAction; rationale: string }[];
}

/**
 * The action is decided HERE, in code, from the verdict. Gemini is told what
 * the recommendation is and asked to justify it in prose -- it does not get to
 * choose, because choosing is a judgement about the user's money.
 */
export function suggestedAction(verdict: UsageVerdict): ProposalAction {
  if (verdict.verdict === "likely-unused") return "cancel";
  if (verdict.verdict === "unknown") return "check";
  return "keep";
}

export function buildProposalInput(result: AnalyzeResult): ProposalInput {
  return {
    asOf: result.asOf,
    lookbackDays: result.lookbackDays,
    totalWasted: result.totalWasted,
    annualSavings: result.annualSavings,
    findings: result.verdicts.map((v) => ({
      merchantKey: v.merchantKey,
      merchant: v.merchant,
      verdict: v.verdict,
      confidence: v.confidence,
      monthlyAmount: v.monthlyAmount,
      zombieScore: v.zombieScore,
      chargeCount: v.evidence.chargeCount,
      totalPaid: v.evidence.totalPaid,
      reason: v.reason,
      suggestedAction: suggestedAction(v),
    })),
  };
}

/**
 * Every number the model is allowed to write, as normalised strings.
 *
 * Small integers are permitted unconditionally: counts and month figures like
 * "3 subscriptions" or "12 months" are ordinary prose, cannot be mistaken for a
 * currency claim, and rejecting them would make the guard fire constantly and
 * therefore get switched off.
 */
export function allowedNumbers(input: ProposalInput): Set<string> {
  const allowed = new Set<string>();
  const add = (n: number) => {
    allowed.add(String(n));
    allowed.add(String(Math.round(n)));
  };

  for (let i = 0; i <= 31; i++) allowed.add(String(i));
  add(input.totalWasted);
  add(input.annualSavings);
  add(input.lookbackDays);
  for (const part of input.asOf.split("-")) allowed.add(String(Number(part)));

  for (const f of input.findings) {
    add(f.monthlyAmount);
    add(f.zombieScore);
    add(f.chargeCount);
    add(f.totalPaid);
    add(f.monthlyAmount * 12);
    // Figures already quoted in the code-authored reason line are fair game,
    // since the model is shown that sentence.
    for (const match of f.reason.matchAll(/\d[\d,]*\.?\d*/g)) {
      allowed.add(match[0].replace(/,/g, ""));
    }
  }
  return allowed;
}

/** Numbers appearing in `text` that were never given to the model. */
export function foreignNumbers(text: string, allowed: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\d[\d,]*\.?\d*/g)) {
    const normalised = match[0].replace(/,/g, "").replace(/\.$/, "");
    if (!allowed.has(normalised) && !allowed.has(String(Number(normalised)))) {
      found.push(match[0]);
    }
  }
  return found;
}

/** True when every number in the plan traces back to the input. */
export function planIsGrounded(plan: PlanText, input: ProposalInput): boolean {
  const allowed = allowedNumbers(input);
  if (foreignNumbers(plan.summary, allowed).length > 0) return false;
  return plan.items.every((item) => foreignNumbers(item.rationale, allowed).length === 0);
}

/**
 * The deterministic plan. Not a degraded mode -- it is the floor the whole
 * feature stands on, which is why the Gemini path can be discarded without a
 * second thought whenever it produces something unverifiable.
 */
export function templatePlan(input: ProposalInput): PlanText {
  const cancel = input.findings.filter((f) => f.suggestedAction === "cancel");
  const check = input.findings.filter((f) => f.suggestedAction === "check");
  const keep = input.findings.filter((f) => f.suggestedAction === "keep");

  const sentences: string[] = [];
  if (cancel.length > 0) {
    sentences.push(
      `${cancel.length} of your ${input.findings.length} recurring charges show no sign of use. Cancelling them stops ${inr(input.annualSavings)} a year, and they have already cost you ${inr(input.totalWasted)}.`,
    );
  } else {
    sentences.push(`Nothing looks wasted right now across your ${input.findings.length} recurring charges.`);
  }
  if (check.length > 0) {
    sentences.push(
      `${check.length} more leave no trace in your transactions, so they are not counted either way until you say.`,
    );
  }
  if (keep.length > 0) {
    sentences.push(`${keep.length} you are clearly still using — keep those.`);
  }

  return {
    summary: sentences.join(" "),
    items: input.findings.map((f) => ({
      merchantKey: f.merchantKey,
      action: f.suggestedAction,
      rationale:
        f.suggestedAction === "cancel"
          ? `${f.reason} Cancelling saves ${inr(f.monthlyAmount)} a month.`
          : f.suggestedAction === "check"
            ? `${f.reason} Answer the question and this becomes a firm verdict.`
            : f.reason,
    })),
  };
}

/**
 * The prompt. Every figure is supplied; the model is asked for sentences.
 */
export function buildPrompt(input: ProposalInput): string {
  const rows = input.findings
    .map((f) =>
      [
        `- merchantKey: ${f.merchantKey}`,
        `  name: ${f.merchant}`,
        `  recommendation (already decided, do not change): ${f.suggestedAction}`,
        `  monthly cost: ${inr(f.monthlyAmount)}`,
        `  wasted so far: ${inr(f.zombieScore)}`,
        `  our finding: ${f.reason}`,
      ].join("\n"),
    )
    .join("\n");

  return [
    "You are writing the summary of a subscription review for the person whose",
    "money it is. Every figure below has already been computed from their",
    "transaction history.",
    "",
    "ABSOLUTE RULE: do not calculate, estimate, total, or introduce ANY number",
    "that is not written below. Reproduce the ones you use exactly as given. If",
    "you want to mention an amount you have not been given, describe it in words",
    "instead. A response containing an unfamiliar number will be discarded.",
    "",
    `Total wasted to date: ${inr(input.totalWasted)}`,
    `Annual saving if every flagged subscription is cancelled: ${inr(input.annualSavings)}`,
    `Usage was checked over the last ${input.lookbackDays} days.`,
    "",
    "Findings:",
    rows,
    "",
    "Write:",
    '- "summary": two or three sentences. Plain, direct, not salesy. Lead with',
    "  what is being wasted. No greeting and no sign-off.",
    '- "items": one entry per merchantKey above, keeping the given action, with a',
    "  one-sentence rationale in the second person. For a `check` action, say",
    "  plainly that we cannot tell and are asking rather than guessing.",
  ].join("\n");
}
