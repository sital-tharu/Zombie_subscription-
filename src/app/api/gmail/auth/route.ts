import { NextResponse } from "next/server";
import { consentUrl, hasGmailCredentials } from "@/lib/gmail-auth";
import { requireOwner } from "@/lib/auth";

/**
 * Start the OAuth dance. Owner-gated, because anyone who reaches this on the
 * public deployment could otherwise attach THEIR mailbox to this dashboard.
 */
export async function GET(request: Request) {
  const denied = requireOwner(request);
  if (denied) return denied;

  if (!hasGmailCredentials()) {
    return NextResponse.json(
      { error: "Gmail is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET." },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  return NextResponse.redirect(consentUrl(url.origin));
}
