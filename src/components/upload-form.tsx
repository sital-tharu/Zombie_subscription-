"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { uploadAction, type UploadResult } from "@/app/actions";
import { inr, shortDate } from "@/lib/format";

/**
 * Screenshot intake, on a page of its own.
 *
 * Gemini reads the image; everything downstream of it is deterministic, and the
 * extracted rows are validated by Zod before they go anywhere near a charge
 * chain. What makes this a page rather than a button is the last step: the rows
 * are listed back. A payee misread as "AIRTFI PREPAID" is obvious in a list and
 * completely invisible in a success count, and the user is the only one who can
 * spot it.
 *
 * Submission goes through a server action rather than fetch() to /api/extract.
 * That route is gated by an owner passcode, and handing the passcode to the
 * browser so the browser can hand it back would be theatre.
 */
export function UploadForm({ hasGeminiKey }: { hasGeminiKey: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  if (!hasGeminiKey) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-edge)] p-8 text-center">
        <p className="text-[var(--color-muted)]">Screenshot intake is switched off.</p>
        <p className="mt-2 text-[13px] text-[var(--color-dim)]">
          Set <code className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5">GEMINI_API_KEY</code>{" "}
          in <code className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5">.env.local</code> and
          reload. Everything else in the app works without it.
        </p>
      </div>
    );
  }

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setResult(null);
    if (!file) {
      setPreview(null);
      setFileName(null);
      return;
    }
    // Revoked in reset(), not here -- the URL is still on screen until then.
    setPreview(URL.createObjectURL(file));
    setFileName(file.name);
  };

  const submit = () => {
    const file = inputRef.current?.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.set("screenshot", file);
    startTransition(async () => {
      setResult(await uploadAction(formData));
    });
  };

  const reset = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFileName(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
        id="screenshot-input"
      />

      {!result?.ok && (
        <>
          <label
            htmlFor="screenshot-input"
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-edge)] px-6 py-10 text-center transition-colors hover:border-[var(--color-muted)]"
          >
            {preview ? (
              /* A blob: URL straight from the file picker. next/image cannot
                 optimise one, and routing it through the image pipeline would
                 mean allow-listing a scheme for a thumbnail the user is
                 looking at for four seconds. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt=""
                className="max-h-64 rounded-lg border border-[var(--color-edge)] object-contain"
              />
            ) : (
              <>
                <span className="text-2xl" aria-hidden="true">
                  📷
                </span>
                <span className="text-sm font-medium">Choose a payment screenshot</span>
                <span className="text-[13px] text-[var(--color-dim)]">
                  A Google Pay history screen works best · PNG or JPG, up to 8 MB
                </span>
              </>
            )}
          </label>

          {fileName && (
            <p className="mt-2 truncate text-center text-[13px] text-[var(--color-dim)]">
              {fileName}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={pending || !fileName}
              className="rounded-lg bg-[var(--color-invert-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--color-invert-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {pending ? "Reading screenshot…" : "Read this screenshot"}
            </button>
            {fileName && !pending && (
              <button
                type="button"
                onClick={reset}
                className="text-sm text-[var(--color-dim)] underline underline-offset-4 hover:text-[var(--color-muted)]"
              >
                Choose a different one
              </button>
            )}
          </div>
        </>
      )}

      {result && !result.ok && (
        <p className="mt-4 rounded-lg bg-[var(--color-zombie-dim)] px-3.5 py-2.5 text-[13px] text-[var(--color-zombie)]">
          {result.message}
        </p>
      )}

      {result?.ok && (
        <div>
          <p className="rounded-lg bg-[var(--color-alive-dim)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-alive)]">
            {result.message}
          </p>

          <h2 className="mt-6 text-[13px] text-[var(--color-muted)]">
            What was read — check it before you trust it
          </h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-[var(--color-edge)]">
            <table className="w-full min-w-[380px] text-[13px]">
              <thead>
                <tr className="bg-[var(--color-panel)] text-left text-xs text-[var(--color-muted)]">
                  <th className="px-3.5 py-2 font-medium">Date</th>
                  <th className="px-3.5 py-2 font-medium">Merchant</th>
                  <th className="px-3.5 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--color-edge)]">
                    <td className="px-3.5 py-2 whitespace-nowrap text-[var(--color-muted)]">
                      {shortDate(row.date)}
                    </td>
                    <td className="px-3.5 py-2">{row.merchant}</td>
                    <td className="tnum px-3.5 py-2 text-right font-mono">{inr(row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-[var(--color-dim)]">
            A payment only becomes a subscription once three of them line up about a month
            apart at roughly the same amount. Anything short of that appears on the dashboard
            under <span className="text-[var(--color-muted)]">Not yet a subscription</span>,
            with what it is still waiting for.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link
              href="/"
              className="rounded-lg bg-[var(--color-invert-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--color-invert-fg)] transition-opacity hover:opacity-90"
            >
              See the dashboard →
            </Link>
            <button
              type="button"
              onClick={reset}
              className="text-sm text-[var(--color-dim)] underline underline-offset-4 hover:text-[var(--color-muted)]"
            >
              Upload another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
