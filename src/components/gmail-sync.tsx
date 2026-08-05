"use client";

import { useState, useTransition } from "react";
import { syncGmailAction } from "@/app/actions";

/**
 * Layer 2b's one control.
 *
 * Connecting is a plain link to the owner-gated auth route rather than a
 * fetch: OAuth needs a full-page navigation to Google and back, and there is
 * nothing to intercept in between.
 *
 * Syncing goes through a server action, so the owner passcode never reaches the
 * browser -- the same reason every other control on this dashboard avoids the
 * HTTP routes.
 */
export function GmailSync({
  connected,
  label,
  emailCount,
}: {
  connected: boolean;
  label: string;
  emailCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (!connected) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <a
          href="/api/gmail/auth"
          className="rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-muted)]"
        >
          Connect Gmail
        </a>
        <span className="text-xs text-[var(--color-dim)]">
          Reads only message headers, only from a label you choose. Never message
          contents — Google does not grant them.
        </span>
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
            : `Label mail "${label}" in Gmail, then sync`}
        </span>
      )}
    </div>
  );
}
