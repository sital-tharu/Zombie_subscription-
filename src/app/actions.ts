"use server";

import { revalidatePath } from "next/cache";
import { ingestScreenshot, recordAnswer } from "@/lib/ingest";
import { generateProposal, setProposalDecision } from "@/lib/plan-service";

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

export async function uploadAction(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const file = formData.get("screenshot");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a screenshot first." };
  }
  if (!file.type.startsWith("image/")) {
    return { ok: false, message: "That file is not an image." };
  }
  if (file.size > 8 * 1024 * 1024) {
    return { ok: false, message: "Image is larger than 8 MB." };
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const { added, transactions } = await ingestScreenshot(bytes, file.type);
    revalidatePath("/");
    if (added === 0) {
      return { ok: false, message: "No payments could be read from that image." };
    }
    const names = [...new Set(transactions.map((t) => t.merchant))].slice(0, 3).join(", ");
    return {
      ok: true,
      message: `Added ${added} transaction${added === 1 ? "" : "s"} — ${names}${added > 3 ? "…" : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Extraction failed.",
    };
  }
}

/** Demo beat six: the plan, and the annual savings total. */
export async function generatePlanAction(): Promise<{ fallbackReason: string | null }> {
  const { fallbackReason } = await generateProposal();
  revalidatePath("/");
  return { fallbackReason };
}

/** The agent proposes; the human disposes. */
export async function decideAction(id: string, status: "accepted" | "rejected") {
  await setProposalDecision(id, status);
  revalidatePath("/");
}
