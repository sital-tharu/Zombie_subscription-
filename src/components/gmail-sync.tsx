"use client";

import { useState, useTransition } from "react";
import { connectGmailAction, syncGmailAction } from "@/app/actions";

/**
 * Layer 2b's one control.
 *
 * Connecting asks for the owner passcode; syncing does not. That asymmetry is
 * deliberate. Syncing re-reads mail the owner already labelled, so a passer-by
 * triggering it achieves nothing. Connecting binds an EXTERNAL account, and on
 * a public deployment an open connect flow would let a stranger attach their
 * own mailbox and have their message headers written into a database anyone can
 * read -- which harms them, not us.
 *
 * The passcode is typed, never embedded. Both paths go through server actions
 * rather than the HTTP routes, so no secret is ever shipped to the page.
 */
export function GmailSync({
  configured,
  protectedByKey,
  connected,
  label,
  emailCount,
}: {
  /** GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are both present. */
  configured: boolean;
  /** OWNER_KEY is set, so connecting asks for it. */
  protectedByKey: boolean;
  connected: boolean;
  label: string;
  emailCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Shown rather than hidden. An earlier version rendered nothing at all
  // without credentials, which left no way to tell an unbuilt feature from an
  // unconfigured one -- the same silence that made an uploaded screenshot
  // vanish, and just as unhelpful.
  if (!configured) {
    return (
      <details className="rounded-lg border border-dashed border-[var(--color-edge)]">
        <summary className="flex items-center gap-2 px-3.5 py-2 text-sm text-[var(--color-muted)]">
          <svg className="chev size-3 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M6 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Connect Gmail — needs setup
        </summary>
        <div className="space-y-2 border-t border-[var(--color-edge)] px-3.5 py-3 text-[13px] text-[var(--color-muted)]">
          <p>
            Two things at once. Bills in your labelled mail become transactions, with
            their amounts, listed alongside everything else. And order confirmations
            count as proof you used a service — catching spending this app never sees,
            like a Swiggy order paid by card, which would otherwise look like silence.
            Silence is what gets flagged as a zombie.
          </p>
          <p>Two one-off steps, both yours to do:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In the{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[var(--color-alive)] underline underline-offset-2"
              >
                Google Cloud console
              </a>
              , enable the Gmail API and create an OAuth client ID of type{" "}
              <span className="text-[var(--color-fg)]">Web application</span>. Add{" "}
              <code className="rounded bg-[var(--color-panel-2)] px-1 py-0.5 text-xs">
                http://localhost:3000/api/gmail/callback
              </code>{" "}
              as an authorised redirect URI, plus the same path on your deployment.
            </li>
            <li>
              Put the client id and secret in{" "}
              <code className="rounded bg-[var(--color-panel-2)] px-1 py-0.5 text-xs">
                .env.local
              </code>
              , then restart the dev server.
            </li>
          </ol>
          <div className="overflow-x-auto rounded-lg bg-[var(--color-panel)] p-3 font-mono text-xs">
            <div>GMAIL_CLIENT_ID=</div>
            <div>GMAIL_CLIENT_SECRET=</div>
            <div>GMAIL_LABEL={label}</div>
          </div>
          <p className="text-[var(--color-dim)]">
            The app asks for the <span className="font-mono">gmail.readonly</span> scope,
            because a bill&apos;s amount is in the message body and no narrower scope can
            reach it. Only mail carrying your label is ever fetched — Gmail has no
            label-scoped permission, so that limit is one this code keeps rather than one
            Google enforces.
          </p>
        </div>
      </details>
    );
  }

  if (!connected) {
    // A plain <a> to /api/gmail/auth cannot work: that route is owner-gated and
    // a browser navigation carries no x-owner-key header, so it 401s. The
    // passcode is typed by the person instead, checked server-side, and the
    // consent URL only comes back if it was right.
    const connect = () => {
      const key = protectedByKey ? (window.prompt("Owner passcode") ?? "") : "";
      if (protectedByKey && key === "") return;
      startTransition(async () => {
        const outcome = await connectGmailAction(key);
        if ("error" in outcome) {
          setResult({ ok: false, message: outcome.error });
          return;
        }
        window.location.href = outcome.url;
      });
    };

    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={connect}
          disabled={pending}
          className="rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-muted)] disabled:opacity-50"
        >
          {pending ? "Opening Google…" : "Connect Gmail"}
        </button>
        {result && !result.ok ? (
          <span className="text-xs text-[var(--color-zombie)]">{result.message}</span>
        ) : (
          <span className="text-xs text-[var(--color-dim)]">
            Reads bills and confirmations from the &ldquo;{label}&rdquo; label only.
            Nothing else in your mailbox is fetched.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(await syncGmailAction());
          })
        }
        className="rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-muted)] disabled:opacity-50"
      >
        {pending ? "Reading inbox…" : `Sync "${label}"`}
      </button>
      {result ? (
        <span
          className={`text-xs ${result.ok ? "text-[var(--color-alive)]" : "text-[var(--color-zombie)]"}`}
        >
          {result.message}
        </span>
      ) : (
        <span className="text-xs text-[var(--color-dim)]">
          {emailCount > 0
            ? `${emailCount} message${emailCount === 1 ? "" : "s"} read so far`
            : `Apply the "${label}" label to your bills in Gmail, then sync`}
        </span>
      )}
    </div>
  );
}
