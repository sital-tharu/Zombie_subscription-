import { requireOwner } from "@/lib/auth";
import { generateProposal, setProposalDecision } from "@/lib/plan-service";
import { getStore } from "@/lib/store";

/**
 * POST  /api/proposal              generate a plan from the current findings
 * PATCH /api/proposal  { id, status }   accept or reject it
 *
 * The agent proposes; the human disposes. Nothing is ever cancelled on the
 * user's behalf -- that is a permanent product principle, not a scope cut.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const denied = requireOwner(request);
  if (denied) return denied;

  const { proposal, fallbackReason } = await generateProposal();
  return Response.json({ proposal, fallbackReason });
}

export async function PATCH(request: Request) {
  const denied = requireOwner(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const { id, status } = (body ?? {}) as { id?: string; status?: string };
  if (!id || (status !== "accepted" && status !== "rejected")) {
    return Response.json(
      { error: 'Expected { id, status: "accepted" | "rejected" }.' },
      { status: 400 },
    );
  }

  await setProposalDecision(id, status);
  return Response.json({ id, status });
}

export async function GET(request: Request) {
  const denied = requireOwner(request);
  if (denied) return denied;

  const store = await getStore();
  return Response.json({ proposal: await store.latestProposal() });
}
