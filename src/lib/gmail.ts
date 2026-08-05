/**
 * Layer 2b intake: pull message headers for one label and store them.
 *
 * Written around two hard constraints of the `gmail.metadata` scope, both of
 * which make the donor project's approach impossible to copy:
 *
 *   1. **`q` is forbidden.** `users.messages.list?q=label:zombie` returns 400
 *      under metadata. Filtering is by `labelIds`, so the label name is
 *      resolved to an id first via `users.labels.list`. This is stricter than
 *      the donor's free-text query, not looser -- there is no search at all,
 *      only "messages carrying this exact label".
 *   2. **`format` must be `metadata`.** `full` and `raw` are rejected. We ask
 *      for exactly three headers and could not read a body if we wanted to.
 *
 * Nothing here decides what an email means. Matching against the merchant map
 * happens in the engine at analyse time, so widening the map later takes effect
 * on mail synced months ago, and so this file can never put a judgement into
 * storage.
 */
import { getAccessToken } from "./gmail-auth";
import { getStore } from "./store";
import type { EmailEvent } from "./types";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The label the user applies to mail they want read. Nothing else is fetched. */
export function gmailLabel(): string {
  return process.env.GMAIL_LABEL ?? "zombie";
}

export interface SyncResult {
  label: string;
  scanned: number;
  stored: number;
  skipped: number;
}

async function gmailFetch(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    // The metadata scope rejects `q` with a 400 that says nothing useful about
    // why, so name the likely cause rather than leaving a bare status code.
    const hint = res.status === 400 ? " (metadata scope forbids search queries — filter by labelIds)" : "";
    throw new Error(`Gmail ${path} failed (${res.status})${hint}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

interface GmailHeader {
  name: string;
  value: string;
}

function header(headers: GmailHeader[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * RFC 2822 date to YYYY-MM-DD.
 *
 * Returns null rather than guessing on an unparseable header. A message whose
 * date we cannot read has no place on a timeline that decides whether money was
 * wasted, and dropping one is cheaper than dating it wrongly.
 */
export function headerDateToIso(raw: string): string | null {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/** Resolve a label NAME to its id. Metadata scope permits listing labels. */
async function findLabelId(name: string, token: string): Promise<string | null> {
  const data = await gmailFetch("/labels", token);
  const labels = (data.labels ?? []) as { id: string; name: string }[];
  const wanted = name.trim().toLowerCase();
  return labels.find((l) => l.name.toLowerCase() === wanted)?.id ?? null;
}

export async function syncGmail(
  maxResults = Number(process.env.GMAIL_MAX_RESULTS) || 200,
): Promise<SyncResult | { needsAuth: true } | { missingLabel: string }> {
  const token = await getAccessToken();
  if (!token) return { needsAuth: true };

  const label = gmailLabel();
  const labelId = await findLabelId(label, token);
  if (!labelId) return { missingLabel: label };

  const list = await gmailFetch(
    `/messages?labelIds=${encodeURIComponent(labelId)}&maxResults=${maxResults}`,
    token,
  );
  const messages = (list.messages ?? []) as { id: string }[];

  const events: EmailEvent[] = [];
  let skipped = 0;

  for (const { id } of messages) {
    const msg = await gmailFetch(
      `/messages/${id}?format=metadata` +
        "&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",
      token,
    );
    const payload = (msg.payload ?? {}) as { headers?: GmailHeader[] };
    const headers = payload.headers ?? [];
    const date = headerDateToIso(header(headers, "Date"));
    if (!date) {
      skipped++;
      continue;
    }
    events.push({
      id,
      from: header(headers, "From"),
      subject: header(headers, "Subject"),
      date,
    });
  }

  // Upsert keyed on the Gmail message id, so syncing the same label twice
  // stores the same rows twice rather than doubling the evidence.
  const store = await getStore();
  const stored = await store.saveEmails(events);

  return { label, scanned: messages.length, stored, skipped };
}
