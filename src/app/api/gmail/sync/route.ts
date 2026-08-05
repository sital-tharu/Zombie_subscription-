import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { syncGmail } from "@/lib/gmail";

// Fetching a few hundred message headers one at a time takes longer than the
// default serverless slice allows.
export const maxDuration = 60;

export async function POST(request: Request) {
  const denied = requireOwner(request);
  if (denied) return denied;

  try {
    const result = await syncGmail();
    if ("needsAuth" in result) {
      return NextResponse.json({ error: "Gmail is not connected." }, { status: 401 });
    }
    if ("missingLabel" in result) {
      return NextResponse.json(
        { error: `No Gmail label named "${result.missingLabel}". Create it and label the mail you want read.` },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed." },
      { status: 502 },
    );
  }
}
