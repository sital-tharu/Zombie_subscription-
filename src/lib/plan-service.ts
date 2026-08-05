/**
 * Generating and storing a proposal. Shared by the server action the dashboard
 * uses and the HTTP route, so both take exactly the same path.
 */
import { randomUUID } from "node:crypto";
import { analyze } from "./correlate";
import { addMonths, lastDayOfMonth, monthKey } from "./format";
import { GEMINI_MODEL, getGeminiClient, hasGeminiKey } from "./gemini";
import {
  buildPrompt,
  buildProposalInput,
  planIsGrounded,
  templatePlan,
  type PlanText,
  type ProposalInput,
} from "./proposal";
import { ProposalResponseSchema } from "./schemas";
import { getStore, type StoredProposal } from "./store";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          merchantKey: { type: "string" },
          action: { type: "string", enum: ["cancel", "downgrade", "keep", "check"] },
          rationale: { type: "string" },
        },
        required: ["merchantKey", "action", "rationale"],
      },
    },
  },
  required: ["summary", "items"],
};

export interface GeneratedPlan {
  proposal: StoredProposal;
  /** Why the templated plan was used, when it was. Surfaced in the UI. */
  fallbackReason: string | null;
}

export async function generateProposal(): Promise<GeneratedPlan> {
  const store = await getStore();
  const [transactions, answers] = await Promise.all([
    store.listTransactions(),
    store.listAnswers(),
  ]);
  const result = analyze(transactions, undefined, { answers });

  /*
   * A second run, as of the end of last month, purely so the plan can say what
   * changed. `analyze` is pure and cheap over a few thousand rows, and running
   * it twice is far safer than storing last month's verdicts and hoping they
   * were computed by the same version of the engine.
   */
  const previousAsOf = lastDayOfMonth(addMonths(monthKey(result.asOf), -1));
  const previous =
    result.historyStart !== null && result.historyStart <= previousAsOf
      ? analyze(transactions, previousAsOf, { answers })
      : undefined;

  const input = buildProposalInput(result, previous);

  const { plan, generatedBy, fallbackReason } = await writePlan(input);

  const proposal: StoredProposal = {
    id: randomUUID(),
    planText: plan.summary,
    items: plan.items,
    // Copied from the engine's output. Never requested from, or touched by, a model.
    annualSavings: result.annualSavings,
    totalWasted: result.totalWasted,
    status: "pending",
    generatedBy,
    createdAt: new Date().toISOString(),
  };

  await store.saveProposal(proposal);
  return { proposal, fallbackReason };
}

async function writePlan(input: ProposalInput): Promise<{
  plan: PlanText;
  generatedBy: "gemini" | "template";
  fallbackReason: string | null;
}> {
  const template = templatePlan(input);
  if (!hasGeminiKey()) {
    return { plan: template, generatedBy: "template", fallbackReason: "No Gemini key configured." };
  }

  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: buildPrompt(input),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA,
        temperature: 0.4,
      },
    });

    const parsed = ProposalResponseSchema.safeParse(JSON.parse(response.text ?? ""));
    if (!parsed.success) {
      return { plan: template, generatedBy: "template", fallbackReason: "Response failed validation." };
    }

    // Keep only items matching a real finding, and keep OUR action rather than
    // the model's: the recommendation is a judgement about the user's money and
    // is decided in code.
    const byKey = new Map(input.findings.map((f) => [f.merchantKey, f]));
    const items = parsed.data.items
      .filter((item) => byKey.has(item.merchantKey))
      .map((item) => ({
        merchantKey: item.merchantKey,
        action: byKey.get(item.merchantKey)!.suggestedAction,
        rationale: item.rationale,
      }));

    if (items.length !== input.findings.length) {
      return { plan: template, generatedBy: "template", fallbackReason: "Response did not cover every finding." };
    }

    const candidate: PlanText = { summary: parsed.data.summary, items };
    if (!planIsGrounded(candidate, input)) {
      // The whole response goes, not just the offending sentence. A model that
      // invented one figure cannot be trusted for the rest of the paragraph.
      return {
        plan: template,
        generatedBy: "template",
        fallbackReason: "Response contained a number that was not in the input.",
      };
    }

    return { plan: candidate, generatedBy: "gemini", fallbackReason: null };
  } catch (error) {
    return {
      plan: template,
      generatedBy: "template",
      fallbackReason: error instanceof Error ? error.message : "Gemini call failed.",
    };
  }
}

export async function setProposalDecision(
  id: string,
  status: "accepted" | "rejected",
): Promise<void> {
  const store = await getStore();
  await store.setProposalStatus(id, status);
}

/**
 * Tick or untick one cancellation. Read-modify-write against the stored
 * proposal rather than trusting a list sent by the client, so a stale browser
 * tab cannot wipe progress made elsewhere.
 */
export async function toggleChecklistItem(
  id: string,
  merchantKey: string,
): Promise<string[]> {
  const store = await getStore();
  const proposal = await store.latestProposal();
  if (!proposal || proposal.id !== id) return [];

  const done = new Set(proposal.completedItems ?? []);
  if (done.has(merchantKey)) done.delete(merchantKey);
  else done.add(merchantKey);

  const next = [...done];
  await store.setProposalChecklist(id, next);
  return next;
}
