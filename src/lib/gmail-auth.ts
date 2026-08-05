/**
 * Gmail OAuth. Lifted from Rupee Radar, with two deliberate changes.
 *
 * **The scope is `gmail.metadata`, not `gmail.readonly`.** Metadata grants
 * message headers and nothing else: bodies are unreachable, enforced by Google
 * rather than by our own restraint. That is the whole of what Layer 2b needs,
 * since an order confirmation announces itself in the subject line, and it is
 * what PRD section 12 promises. The cost is that email can never supply a rupee
 * amount, so it can never create a subscription -- only corroborate use of one.
 *
 * Worth being precise about what this does NOT buy, because it is easy to
 * overclaim: Gmail has no label-scoped or sender-scoped OAuth scope. The grant
 * is mailbox-wide whichever scope you pick. What narrows it further is the
 * label filter in gmail.ts, and that is a promise our code keeps, not one
 * Google enforces. Metadata is simply the smallest grant Google actually offers
 * that still answers the question.
 *
 * **The refresh token goes through `Store`, not straight to Firestore.** The
 * donor writes to `config/gmailToken` directly, which would make local
 * dogfooding impossible without a service account -- and dogfooding locally is
 * the entire point of ZOMBIE_STORE=local.
 *
 * No googleapis dependency: three fetch calls is the whole of it.
 */
import { getStore } from "./store";

/**
 * Headers only. Changing this to gmail.readonly would grant the whole mailbox
 * including bodies, and would make PRD section 12 untrue.
 */
const SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const REDIRECT_PATH = "/api/gmail/callback";

function clientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env.local (see README Gmail setup)",
    );
  }
  return { clientId, clientSecret };
}

/** True when Gmail credentials are configured at all. Gates the UI. */
export function hasGmailCredentials(): boolean {
  return Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

export function consentUrl(origin: string): string {
  const params = new URLSearchParams({
    client_id: clientCreds().clientId,
    redirect_uri: origin + REDIRECT_PATH,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Force a refresh token even on reconnects. Google only returns one on the
    // first consent otherwise, so a user who reconnects gets a grant we cannot
    // renew and a sync that dies silently in an hour.
    prompt: "consent",
  });
  const secret = process.env.OWNER_KEY;
  if (secret) params.set("state", secret);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string, origin: string): Promise<void> {
  const { clientId, clientSecret } = clientCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: origin + REDIRECT_PATH,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token — remove this app at " +
        "myaccount.google.com/permissions and connect again",
    );
  }
  const store = await getStore();
  await store.saveGmailToken(data.refresh_token);
}

export async function isGmailConnected(): Promise<boolean> {
  try {
    const store = await getStore();
    return (await store.getGmailToken()) !== null;
  } catch {
    // Store unreachable, e.g. no credentials at all. Unconnected is the honest
    // answer and it keeps the dashboard rendering.
    return false;
  }
}

export async function disconnectGmail(): Promise<void> {
  const store = await getStore();
  await store.clearGmailToken();
}

/** A fresh short-lived access token, or null when Gmail was never connected. */
export async function getAccessToken(): Promise<string | null> {
  const store = await getStore();
  const refreshToken = await store.getGmailToken();
  if (!refreshToken) return null;

  const { clientId, clientSecret } = clientCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Access-token refresh failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()).access_token as string;
}
