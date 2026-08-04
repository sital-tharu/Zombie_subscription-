/**
 * Single-owner access control. Multi-user is a stated non-goal.
 *
 * Applies to the HTTP routes only. The dashboard's own buttons go through
 * server actions instead, which are same-origin and never expose the passcode
 * to the browser -- shipping the owner key to the client just so the client can
 * send it back is not authentication, it is decoration.
 */
const OWNER_HEADER = "x-owner-key";

export function ownerKeyConfigured(): boolean {
  return Boolean(process.env.OWNER_KEY);
}

/**
 * Returns a 401 Response when the caller is not the owner, or null when the
 * request may proceed.
 *
 * With OWNER_KEY unset the routes are open, so a clean clone runs without
 * configuration. That is a deliberate demo-grade choice for a single-owner app
 * with no real user data; deployments set the variable.
 */
export function requireOwner(request: Request): Response | null {
  const expected = process.env.OWNER_KEY;
  if (!expected) return null;
  if (request.headers.get(OWNER_HEADER) === expected) return null;
  return Response.json(
    { error: `Missing or incorrect ${OWNER_HEADER} header.` },
    { status: 401 },
  );
}
