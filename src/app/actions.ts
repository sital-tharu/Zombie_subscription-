"use server";

import { revalidatePath } from "next/cache";
import {
  forgetAnswer,
  forgetCancellation,
  ingestScreenshot,
  recordAnswer,
  recordCancellations,
} from "@/lib/ingest";
import {
  generateProposal,
  setProposalDecision,
  toggleChecklistItem,
} from "@/lib/plan-service";

/**
 * Server actions for the dashboard's own controls.
 *
 * Deliberately not fetch() calls to the API routes: those are gated by an owner
 * passcode, and handing that passcode to the browser so the browser can hand it
 * back would be theatre. Server actions are same-origin and the secret stays on
 * the server. The HTTP routes exist for programmatic use.
 */

/** Demo beat five: the agent asks, and the answer sticks. */
export async function answerAction(merchantKey: string, used: boolean) {
  await recordAnswer(merchantKey, used);
  revalidatePath("/");
}

/** One extracted payment, as the upload page lists it back to the user. */
export interface ExtractedRow {
  id: string;
  merchant: string;
  date: string;
  total: number;
}

export interface UploadResult {
  ok: boolean;
  message: string;
  /**
   * What was actually read. Returned rather than summarised because the whole
   * point of the upload page is that the user can check Gemini's work: a payee
   * misread as "AIRTFI" is obvious in a list and invisible in a success count.
   */
  rows: ExtractedRow[];
}

export async function uploadAction(formData: FormData): Promise<UploadResult> {
  const file = formData.get("screenshot");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a screenshot first.", rows: [] };
  }
  if (!file.type.startsWith("image/")) {
    return { ok: false, message: "That file is not an image.", rows: [] };
  }
  if (file.size > 8 * 1024 * 1024) {
    return { ok: false, message: "Image is larger than 8 MB.", rows: [] };
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const { added, transactions } = await ingestScreenshot(bytes, file.type);
    revalidatePath("/");
    if (added === 0) {
      return {
        ok: false,
        message: "No payments could be read from that image.",
        rows: [],
      };
    }
    return {
      ok: true,
      message: `Added ${added} transaction${added === 1 ? "" : "s"}.`,
      rows: transactions.map((t) => ({
        id: t.id,
        merchant: t.merchant,
        date: t.date,
        total: t.total,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Extraction failed.",
      rows: [],
    };
  }
}

/**
 * Revert to the engine's own inference.
 *
 * Without this a mis-tapped answer is permanent: "No, I don't" on an actively
 * used subscription prices its whole chain as waste, with no way back.
 */
export async function clearAnswerAction(merchantKey: string) {
  await forgetAnswer(merchantKey);
  revalidatePath("/");
}

/** Demo beat six: the plan, and the annual savings total. */
export async function generatePlanAction(): Promise<{ fallbackReason: string | null }> {
  const { fallbackReason } = await generateProposal();
  revalidatePath("/");
  return { fallbackReason };
}

/**
 * The agent proposes; the human disposes.
 *
 * Accepting now asserts something concrete -- "I have cancelled these" -- and
 * records a date for each, which is what lets the dashboard stop counting them
 * and lets the panel say "you've saved" rather than "you would save". The claim
 * is not taken on trust: a charge dated after the cancellation puts the
 * subscription straight back into the run rate.
 */
export async function decideAction(
  id: string,
  status: "accepted" | "rejected",
  cancelKeys: readonly string[] = [],
) {
  await setProposalDecision(id, status);
  if (status === "accepted" && cancelKeys.length > 0) {
    await recordCancellations(cancelKeys);
  }
  revalidatePath("/");
}

/** "I didn't actually get round to cancelling that one." */
export async function undoCancellationAction(merchantKey: string) {
  await forgetCancellation(merchantKey);
  revalidatePath("/");
}

/** Tick a cancellation off the checklist. Accepting produces work, not just a status. */
export async function toggleChecklistAction(id: string, merchantKey: string) {
  await toggleChecklistItem(id, merchantKey);
  revalidatePath("/");
}
