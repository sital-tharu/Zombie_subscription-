"use client";

import { useState, useTransition } from "react";
import { decideAction, generatePlanAction } from "@/app/actions";
import { inr } from "@/lib/format";
import type { StoredProposal } from "@/lib/store";

const ACTION_STYLE: Record<string, string> = {
  cancel: "text-[var(--color-zombie)] bg-[var(--color-zombie-dim)]",
  downgrade: "text-[var(--color-unsure)] bg-[var(--color-unsure-dim)]",
  check: "text-[var(--color-unsure)] bg-[var(--color-unsure-dim)]",
  keep: "text-[var(--color-alive)] bg-[var(--color-alive-dim)]",
};

/**
 * Demo beat six.
 *
 * The two figures shown here come from the engine and are stored on the
 * proposal alongside the prose. Gemini writes the sentences; if it ever
 * introduces a number that was not handed to it, the whole response is
 * discarded and the deterministic plan is shown instead -- and the panel says
 * which one you are looking at.
 */
export function PlanPanel({
  proposal,
  merchantNames,
}: {
  proposal: StoredProposal | null;
  merchantNames: Record<string, string>;
}) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const generate = () =>
    startTransition(async () => {
      const { fallbackReason } = await generatePlanAction();
      setNote(fallbackReason);
    });

  const decide = (status: "accepted" | "rejected") => {
    if (!proposal) return;
    startTransition(async () => {
      await decideAction(proposal.id, status);
    });
  };

  if (!proposal) {
    return (
      <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-6 text-center">
        <p className="text-[var(--color-muted)]">
          Ready to turn these findings into a plan you can act on.
        </p>
        <button
          type="button"
          onClick={generate}
          disabled={pending}
          className="mt-4 rounded-lg bg-[#e9edf5] px-5 py-2.5 text-sm font-semibold text-[var(--color-ink)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Writing the plan…" : "Generate my plan"}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl flex-1 text-[15px] leading-relaxed">{proposal.planText}</p>
        <div className="text-right">
          <div className="tnum text-2xl font-semibold text-[var(--color-alive)]">
            {inr(proposal.annualSavings)}
          </div>
          <div className="text-xs text-[var(--color-dim)]">a year if accepted</div>
        </div>
      </div>

      <ul className="mt-5 space-y-2">
        {proposal.items.map((item) => (
          <li key={item.merchantKey} className="flex gap-3 text-sm">
            <span
              className={`mt-0.5 h-fit shrink-0 rounded px-2 py-0.5 text-xs font-medium ${ACTION_STYLE[item.action] ?? ""}`}
            >
              {item.action}
            </span>
            <span className="min-w-0">
              <span className="font-medium">
                {merchantNames[item.merchantKey] ?? item.merchantKey}
              </span>
              <span className="text-[var(--color-muted)]"> — {item.rationale}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[var(--color-edge)] pt-5">
        {proposal.status === "pending" ? (
          <>
            <button
              type="button"
              onClick={() => decide("accepted")}
              disabled={pending}
              className="rounded-lg bg-[var(--color-alive)] px-5 py-2 text-sm font-semibold text-[var(--color-ink)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Accept the plan
            </button>
            <button
              type="button"
              onClick={() => decide("rejected")}
              disabled={pending}
              className="rounded-lg border border-[var(--color-edge)] px-5 py-2 text-sm font-medium transition-colors hover:border-[var(--color-muted)] disabled:opacity-50"
            >
              Not now
            </button>
            <span className="text-xs text-[var(--color-dim)]">
              Nothing is cancelled for you — this is a checklist, not an action.
            </span>
          </>
        ) : (
          <>
            <span
              className={`text-sm font-medium ${proposal.status === "accepted" ? "text-[var(--color-alive)]" : "text-[var(--color-muted)]"}`}
            >
              {proposal.status === "accepted" ? "Plan accepted." : "Plan set aside."}
            </span>
            <button
              type="button"
              onClick={generate}
              disabled={pending}
              className="text-sm text-[var(--color-dim)] underline underline-offset-4 hover:text-[var(--color-muted)] disabled:opacity-50"
            >
              {pending ? "Rewriting…" : "Write a fresh plan"}
            </button>
          </>
        )}

        <span className="ml-auto text-xs text-[var(--color-dim)]">
          {proposal.generatedBy === "gemini"
            ? "Prose by Gemini · every figure computed in code"
            : "Deterministic plan · Gemini output was not used"}
        </span>
      </div>

      {note && (
        <p className="mt-3 text-xs text-[var(--color-unsure)]">
          Fell back to the deterministic plan: {note}
        </p>
      )}
    </div>
  );
}
