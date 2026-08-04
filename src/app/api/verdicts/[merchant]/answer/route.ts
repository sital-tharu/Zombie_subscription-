import { requireOwner } from "@/lib/auth";
import { recordAnswer } from "@/lib/ingest";
import { AnswerRequestSchema } from "@/lib/schemas";

/**
 * POST /api/verdicts/{merchantKey}/answer  { "used": boolean }
 *
 * The user's answer outranks every inference, in both directions, and it
 * persists. A "no" prices the waste from the full charge chain, because an
 * unknown has no usage evidence by construction -- if the user says they never
 * used it, every charge in the chain is waste. That promotion happens in
 * correlate.ts, not here; this route only records what was said.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchant: string }> },
) {
  const denied = requireOwner(request);
  if (denied) return denied;

  const { merchant } = await params;
  if (!merchant) {
    return Response.json({ error: "Missing merchant key." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const parsed = AnswerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'Body must be {"used": true} or {"used": false}.' },
      { status: 400 },
    );
  }

  const answer = await recordAnswer(merchant, parsed.data.used);
  return Response.json({ answer });
}
