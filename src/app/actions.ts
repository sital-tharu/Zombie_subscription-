"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { ownerKeyMatches } from "@/lib/auth";
import { consentUrl, hasGmailCredentials } from "@/lib/gmail-auth";
import {
  forgetAnswer,
  forgetCancellation,
  ingestScreenshot,
  recordAnswer,
  recordCancellations,
} from "@/lib/ingest";
import { syncGmail } from "@/lib/gmail";
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

/**
 * Hand back the Google consent URL, once the caller proves they are the owner.
 *
 * Connecting Gmail is the one control that cannot follow this file's usual
 * "server actions are same-origin, so the secret stays on the server" rule.
 * Every other action is harmless for a passer-by to invoke; this one binds an
 * external account. Left open on a public deployment, a stranger could complete
 * the OAuth flow and have THEIR message headers written into a database anyone
 * can read -- harming them, with our name on it.
 *
 * So the human types the passcode. That is not the same as shipping a server
 * secret to the browser: nothing is embedded in the page, and a wrong answer
 * gets a consent URL for nobody.
 */
export async function connectGmailAction(
  key: string,
): Promise<{ url: string } | { error: string }> {
  if (!ownerKeyMatches(key)) return { error: "That passcode is not right." };
  if (!hasGmailCredentials()) {
    return { error: "Gmail is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET." };
  }
  const headerList = await headers();
  const host = headerList.get("host");
  if (!host) return { error: "Could not determine this app's own address." };
  const proto = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return { url: consentUrl(`${proto}://${host}`) };
}

/**
 * Layer 2b: pull the labelled mail.
 *
 * A server action rather than a browser fetch to /api/gmail/sync, for the same
 * reason as every other control here -- the route is passcode-gated, and
 * handing the passcode to the browser so the browser can hand it back is not
 * authentication.
 */
export async function syncGmailAction(): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await syncGmail();
    if ("needsAuth" in result) {
      return { ok: false, message: "Gmail is not connected yet." };
    }
    if ("missingLabel" in result) {
      return {
        ok: false,
        message: `No Gmail label called "${result.missingLabel}". Create it, label the mail you want read, then sync.`,
      };
    }
    revalidatePath("/");
    const skipped = result.skipped > 0 ? `, ${result.skipped} undated and skipped` : "";
    return {
      ok: true,
      message: `Read ${result.stored} message${result.stored === 1 ? "" : "s"} from "${result.label}"${skipped}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Sync failed.",
    };
  }
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
 * Accepting commits to the plan and nothing more. It deliberately does NOT
 * record any cancellation: the user has not cancelled anything yet, and a
 * dashboard that stopped counting five subscriptions because a button was
 * pressed would be asserting something nobody had done.
 */
export async function decideAction(id: string, status: "accepted" | "rejected") {
  await setProposalDecision(id, status);
  revalidatePath("/");
}

/**
 * Mark one subscription cancelled, or take the mark back.
 *
 * This tick -- not Accept -- is the claim that the user went away and actually
 * cancelled it, so this is where a cancellation date gets written. From here
 * the subscription leaves the run rate and the Recurring count, today and every
 * day after.
 *
 * Still checkable: `applyCancellation` re-tests the claim against the charge
 * history on every render, and a charge dated after the tick overturns it.
 */
export async function toggleCancellationAction(merchantKey: string, cancelled: boolean) {
  if (cancelled) await forgetCancellation(merchantKey);
  else await recordCancellations([merchantKey]);
  revalidatePath("/");
}

