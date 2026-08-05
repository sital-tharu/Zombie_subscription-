"use client";

import { useState, useTransition } from "react";
import { decideAction, generatePlanAction, toggleChecklistAction } from "@/app/actions";
import { inr } from "@/lib/format";
import type { StoredProposal } from "@/lib/store";

const ACTION_STYLE: Record<string, string> = {
  cancel: "text-[var(--color-zombie)] bg-[var(--color-zombie-dim)]",
  downgrade: "text-[var(--color-unsure)] bg-[var(--color-unsure-dim)]",
  check: "text-[var(--color-unsure)] bg-[var(--color-unsure-dim)]",
  keep: "text-[var(--color-alive)] bg-[var(--color-alive-dim)]",
};

export interface ServiceInfo {
  name: string;
  monthlyAmount: number;
  hint: string;
  url?: string;
}

/**
 * Demo beat six, and the answer to "so what does accepting actually do?"
 *
 * Accepting used to write a status and produce nothing. Now it reveals a
 * cancellation checklist: what to cancel, what each one stops, where to do it,
 * and how much is still on the table. The agent still cancels nothing — that is
 * a permanent product principle — but it no longer leaves the user at a dead end.
 *
 * Every figure here comes from the engine via the stored proposal. Gemini wrote
 * the prose and nothing else.
 */
export function PlanPanel({
  proposal,
  services,
}: {
  proposal: StoredProposal | null;
  services: Record<string, ServiceInfo>;
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
          className="mt-4 rounded-lg bg-[var(--color-invert-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--color-invert-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Writing the plan…" : "Generate my plan"}
        </button>
      </div>
    );
  }

  const cancels = proposal.items.filter((i) => i.action === "cancel");
  const done = new Set(proposal.completedItems ?? []);
  const securedMonthly = cancels
    .filter((i) => done.has(i.merchantKey))
    .reduce((sum, i) => sum + (services[i.merchantKey]?.monthlyAmount ?? 0), 0);
  const securedAnnual = securedMonthly * 12;
  // Clamped: a service missing from `services` contributes 0 to securedAnnual
  // while still counting toward annualSavings, which could otherwise render a
  // negative "still on the table".
  const remainingAnnual = Math.max(0, proposal.annualSavings - securedAnnual);

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
                {services[item.merchantKey]?.name ?? item.merchantKey}
              </span>
              <span className="text-[var(--color-muted)]"> — {item.rationale}</span>
            </span>
          </li>
        ))}
      </ul>

      {proposal.status === "accepted" && cancels.length > 0 && (
        <div className="mt-6 border-t border-[var(--color-edge)] pt-5">
          {/*
            What accepting is actually worth, counted only as items are ticked.
            Announcing the full figure the moment Accept is pressed would be the
            one kind of lie this product exists to avoid: nothing is saved until
            the user has genuinely cancelled something.
          */}
          <div className="mb-4 rounded-lg bg-[var(--color-alive-dim)] px-4 py-3">
            {done.size === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">
                Nothing saved yet — tick each one off as you actually cancel it. That is{" "}
                <span className="tnum font-medium text-[var(--color-alive)]">
                  {inr(proposal.annualSavings)}
                </span>{" "}
                a year once the list is clear.
              </p>
            ) : (
              <>
                <p className="tnum text-xl font-semibold text-[var(--color-alive)]">
                  You&apos;ve saved {inr(securedAnnual)} a year
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {remainingAnnual > 0 ? (
                    <>
                      <span className="tnum">{inr(remainingAnnual)}</span> still on the table
                      — {cancels.length - done.size} left to cancel.
                    </>
                  ) : (
                    "Every subscription on this list is cancelled. Nothing left on the table."
                  )}
                </p>
              </>
            )}
          </div>

          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">Your cancellation checklist</h3>
            <span className="text-sm text-[var(--color-muted)]">
              <span className="tnum">
                {done.size} of {cancels.length}
              </span>{" "}
              done
            </span>
          </div>

          <ul className="space-y-2">
            {cancels.map((item) => {
              const service = services[item.merchantKey];
              const ticked = done.has(item.merchantKey);
              return (
                <li
                  key={item.merchantKey}
                  className={`flex gap-3 rounded-lg border border-[var(--color-edge)] p-3 transition-opacity ${ticked ? "opacity-55" : ""}`}
                >
                  <button
                    type="button"
                    disabled={pending}
                    aria-pressed={ticked}
                    onClick={() =>
                      startTransition(async () => {
                        await toggleChecklistAction(proposal.id, item.merchantKey);
                      })
                    }
                    className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-50 ${
                      ticked
                        ? "border-[var(--color-alive)] bg-[var(--color-alive)] text-[var(--color-ink)]"
                        : "border-[var(--color-edge)] hover:border-[var(--color-muted)]"
                    }`}
                  >
                    {ticked && (
                      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
                        <path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`font-medium ${ticked ? "line-through" : ""}`}>
                        {service?.name ?? item.merchantKey}
                      </span>
                      <span className="tnum text-sm text-[var(--color-muted)]">
                        stops {inr(service?.monthlyAmount ?? 0)}/month
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-[var(--color-muted)]">{service?.hint}</p>
                    {service?.url && (
                      <a
                        href={service.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-1 inline-block text-sm text-[var(--color-alive)] underline underline-offset-4"
                      >
                        Open the cancellation page →
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-[var(--color-dim)]">
            You cancel these yourself. Nothing on this list is actioned for you — the agent
            proposes, you decide.
          </p>
        </div>
      )}

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
              Accepting gives you a checklist — nothing is cancelled for you.
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
