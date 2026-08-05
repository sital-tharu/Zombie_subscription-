/**
 * Gmail intake, doing two jobs from one pass over the labelled mail.
 *
 *   1. **Bills become transactions.** The body of a receipt is read by Gemini,
 *      validated by Zod, and stored with `source: "email"` -- so it lands in
 *      All transactions with an Email badge and Layer 1 can chain it into a
 *      subscription. This is why the scope is `gmail.readonly`: an amount lives
 *      in the body, and no amount of header access will ever reveal one.
 *
 *   2. **Confirmations become usage evidence.** The From/Subject/Date of every
 *      message is kept as an EmailEvent, which Layer 2b matches against the
 *      merchant map at analyse time.
 *
 * Only messages carrying the user's label are ever fetched. Filtering is by
 * `labelIds` rather than a `q=label:...` search: an id cannot be fooled by a
 * label whose name merely contains the word, and it costs one extra call to
 * resolve. Note this is a limit THIS CODE imposes -- Gmail has no label-scoped
 * OAuth scope, and pretending otherwise would be a claim that unravels under
 * one question.
 *
 * Nothing here decides what an email means for a verdict. Merchant matching for
 * usage evidence happens in the engine, so widening the map later takes effect
 * on mail synced months ago.
 */
import { extractTransactionsFromText } from "./extract";
import { hasGeminiKey } from "./gemini";
import { getAccessToken } from "./gmail-auth";
import { merchantKeyOf } from "./merchant-map";
import { getStore } from "./store";
import type { EmailEvent, StoredTransaction } from "./types";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The label the user applies to mail they want read. Nothing else is fetched. */
export function gmailLabel(): string {
  return process.env.GMAIL_LABEL ?? "zombie";
}

export interface SyncResult {
  label: string;
  scanned: number;
  /** Header sets kept as Layer 2b usage evidence. */
  stored: number;
  /** Bills read out of message bodies and stored as transactions. */
  billsFound: number;
  skipped: number;
}

/** Decode a base64url body part. */
export function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function flatten(part: GmailPart): GmailPart[] {
  return [part, ...(part.parts ?? []).flatMap(flatten)];
}

const TAG = /<[^>]+>/g;
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/(script|style)>/gi;

/**
 * The readable text of a message.
 *
 * Prefers text/plain over text/html. A receipt's HTML is mostly layout, and
 * handing a model forty kilobytes of table markup to find one rupee figure both
 * wastes the budget and buries the number among class names. HTML is stripped
 * when it is all there is, which for Indian billing mail is often.
 */
export function extractBody(payload: GmailPart): string | null {
  const parts = flatten(payload);
  const pick = (type: string) => parts.find((p) => p.mimeType === type && p.body?.data);

  const plain = pick("text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);

  const html = pick("text/html");
  if (html?.body?.data) {
    return decodeBase64Url(html.body.data)
      .replace(SCRIPT_OR_STYLE, " ")
      .replace(TAG, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  }
  return null;
}

async function gmailFetch(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    // 403 here is nearly always the granted scope being narrower than the code
    // expects -- which happens when the user consented before a scope change
    // and never re-approved. Say so, because the raw message does not.
    const hint =
      res.status === 403
        ? " (the granted scope may predate a change — disconnect and connect again)"
        : "";
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
 * date cannot be read has no place on a timeline that decides whether money was
 * wasted, and dropping one is cheaper than dating it wrongly.
 */
export function headerDateToIso(raw: string): string | null {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/** Resolve a label NAME to its id. */
async function findLabelId(name: string, token: string): Promise<string | null> {
  const data = await gmailFetch("/labels", token);
  const labels = (data.labels ?? []) as { id: string; name: string }[];
  const wanted = name.trim().toLowerCase();
  return labels.find((l) => l.name.toLowerCase() === wanted)?.id ?? null;
}

export async function syncGmail(
  maxResults = Number(process.env.GMAIL_MAX_RESULTS) || 50,
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
  const bills: StoredTransaction[] = [];
  const canReadBills = hasGeminiKey();
  let skipped = 0;

  for (const { id } of messages) {
    const msg = await gmailFetch(`/messages/${id}?format=full`, token);
    const payload = (msg.payload ?? {}) as GmailPart & { headers?: GmailHeader[] };
    const headers = payload.headers ?? [];

    const date = headerDateToIso(header(headers, "Date"));
    if (!date) {
      skipped++;
      continue;
    }

    // Headers first, and unconditionally. Usage evidence costs nothing beyond
    // what has already been fetched, and works with no Gemini key at all.
    events.push({
      id,
      from: header(headers, "From"),
      subject: header(headers, "Subject"),
      date,
    });

    if (!canReadBills) continue;

    const body = extractBody(payload);
    if (!body) continue;

    try {
      const extracted = await extractTransactionsFromText(body, date);
      for (const [index, txn] of extracted.entries()) {
        bills.push({
          // The Gmail message id is baked in, so re-syncing the same label
          // overwrites rather than duplicating -- unlike a screenshot upload,
          // where a repeat genuinely is a second attempt worth seeing.
          id: `gm-${id}-${merchantKeyOf(txn.merchant)}-${index + 1}`,
          merchant: txn.merchant,
          date: txn.date,
          total: txn.total,
          category: txn.category,
          source: "email",
          createdAt: new Date().toISOString(),
        });
      }
    } catch {
      // One unreadable receipt must not abandon the whole sync. The header set
      // is already recorded, so the message still counts as usage evidence --
      // it just contributes no amount.
      skipped++;
    }
  }

  const store = await getStore();
  const stored = await store.saveEmails(events);
  if (bills.length > 0) await store.addTransactions(bills);

  return { label, scanned: messages.length, stored, billsFound: bills.length, skipped };
}
