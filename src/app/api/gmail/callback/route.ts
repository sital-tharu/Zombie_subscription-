import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/gmail-auth";
import { ownerKeyMatches } from "@/lib/auth";

/**
 * Where Google sends the user back.
 *
 * Not owner-gated by header -- Google cannot send one. The `state` parameter
 * carries the owner key instead, so a callback that did not originate from our
 * own gated auth route is rejected.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  if (!ownerKeyMatches(url.searchParams.get("state"))) {
    return NextResponse.redirect(new URL("/?gmail=error&reason=bad_state", url.origin));
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) {
    return NextResponse.redirect(
      new URL(`/?gmail=error&reason=${encodeURIComponent(error ?? "no_code")}`, url.origin),
    );
  }

  try {
    await exchangeCode(code, url.origin);
    return NextResponse.redirect(new URL("/?gmail=connected", url.origin));
  } catch (err) {
    console.error("Gmail token exchange failed:", err);
    return NextResponse.redirect(new URL("/?gmail=error&reason=exchange", url.origin));
  }
}
