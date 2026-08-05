"use client";

import { useState, useTransition } from "react";
import { decideAction, generatePlanAction, undoCancellationAction } from "@/app/actions";
import { inr, shortDate } from "@/lib/format";
import type { StoredProposal } from "@/lib/store";

export interface ServiceInfo {
  name: string;
  monthlyAmount: number;
  /** zombieScore -- what this subscription has already cost with nothing to show. */
  wasted: number;
  /** potentialWaste -- what is riding on an unanswered question. */
  atStake: number;
  /** Set once the user has declared this cancelled. */
  cancelledAt?: string;
  /** True when a charge arrived AFTER that date, i.e. it did not take. */
  stillBilling?: boolean;
  hint: string;
  url?: string;
}

/**
 * Demo beat six: the plan, and what accepting it is actually worth.
 *
 * Structured as numbered steps rather than one flat list. The flat version put
 * "cancel Amazon Prime" and "keep Swiggy One" side by side with the same weight,
 * behind bare lowercase tags, and hid every cancellation instruction until after
 * the Accept button had been pressed -- so the one screen whose job is "what do
 * I do now" answered it last. Now the work comes first, priced per item, with
 * the instructions visible before you commit to anything.
 *
 * Accepting still changes something real: the same cards become tickable, and
 * the savings figure only counts what has actually been ticked. The agent
 * cancels nothing -- that is a permanent product principle -- but it no longer
 * leaves the user at a dead end.
 *
 * Every figure comes from the engine via the stored proposal. Gemini wrote the
 * opening paragraph and nothing else.
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
    // Accepting asserts "I have cancelled these", so the keys go with it and
    // the engine stops counting them from today.
    const keys =
      status === "accepted"
        ? proposal.items
            .filter((i) => i.action === "cancel" || i.action === "downgrade")
            .map((i) => i.merchantKey)
        : [];
    startTransition(async () => {
      await decideAction(proposal.id, status, keys);
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

  // "downgrade" joins the cancel step: both are money you stop spending, and
  // suggestedAction never emits it today, so a separate step would be an empty
  // heading waiting for a feature.
  const toCancel = proposal.items.filter(
    (i) => i.action === "cancel" || i.action === "downgrade",
  );
  const toDecide = proposal.items.filter((i) => i.action === "check");
  const toKeep = proposal.items.filter((i) => i.action === "keep");

  const accepted = proposal.status === "accepted";
  const anyStillBilling = toCancel.some((i) => services[i.merchantKey]?.stillBilling);
  // Only cancellations that actually took. One contradicted by a later charge
  // has saved nothing, so it cannot appear in a figure headed "you've saved".
  const securedAnnual =
    toCancel
      .filter((i) => {
        const s = services[i.merchantKey];
        return s?.cancelledAt !== undefined && !s.stillBilling;
      })
      .reduce((sum, i) => sum + (services[i.merchantKey]?.monthlyAmount ?? 0), 0) * 12;
  const backInTotal = Math.max(0, proposal.annualSavings - securedAnnual);
  const cancelledOn = toCancel
    .map((i) => services[i.merchantKey]?.cancelledAt)
    .find((d): d is string => typeof d === "string");
  const atStakeTotal = toDecide.reduce(
    (sum, i) => sum + (services[i.merchantKey]?.atStake ?? 0),
    0,
  );

  // Numbered in the order they are shown, skipping any step with nothing in it,
  // so a user with no zombies never reads "step 2" as their first instruction.
  let step = 0;

  return (
    <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-xl flex-1 text-[15px] leading-relaxed">{proposal.planText}</p>
        <div className="text-right">
          <div className="tnum text-2xl font-semibold text-[var(--color-alive)]">
            {inr(proposal.annualSavings)}
          </div>
          <div className="text-xs text-[var(--color-dim)]">a year on the table</div>
        </div>
      </div>

      {accepted && toCancel.length > 0 && (
        <div
          className={`mt-5 rounded-lg px-4 py-3 ${
            anyStillBilling
              ? "border border-[var(--color-unsure)]/40 bg-[var(--color-unsure-dim)]"
              : "bg-[var(--color-alive-dim)]"
          }`}
        >
          <p className="tnum text-xl font-semibold text-[var(--color-alive)]">
            You&apos;ve saved {inr(securedAnnual)} a year
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {toCancel.length} {toCancel.length === 1 ? "subscription" : "subscriptions"}{" "}
            marked cancelled
            {cancelledOn && <> on {shortDate(cancelledOn)}</>}
            {!anyStillBilling && <> · they no longer count toward your monthly total</>}
          </p>
          {anyStillBilling && (
            <p className="mt-2 text-xs font-medium text-[var(--color-unsure)]">
              But <span className="tnum">{inr(backInTotal)}</span> of that has billed you
              again since, so it is back in your monthly total — check the flagged row above.
              The cancellation may not have gone through.
            </p>
          )}
        </div>
      )}

      {toCancel.length > 0 && (
        <Step
          n={++step}
          title={`Cancel ${toCancel.length === 1 ? "this one" : `these ${toCancel.length}`}`}
          note={`saves ${inr(proposal.annualSavings)} a year`}
          tone="text-[var(--color-zombie)]"
        >
          <div className="flex flex-col gap-2">
            {toCancel.map((item) => {
              const service = services[item.merchantKey];
              const settled = Boolean(service?.cancelledAt) && !service?.stillBilling;
              return (
                <div
                  key={item.merchantKey}
                  className={`rounded-lg border border-[var(--color-edge)] p-3 transition-opacity ${settled ? "opacity-70" : ""}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className={`font-medium ${settled ? "line-through" : ""}`}>
                          {service?.name ?? item.merchantKey}
                        </span>
                        <span className="text-sm">
                          <span className="tnum text-[var(--color-muted)]">
                            {inr(service?.monthlyAmount ?? 0)}/mo
                          </span>
                          {(service?.wasted ?? 0) > 0 && (
                            <>
                              <span className="mx-1.5 text-[var(--color-dim)]">·</span>
                              <span className="tnum text-[var(--color-zombie)]">
                                {inr(service!.wasted)} wasted
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                      <p className="mt-1 text-[13px] text-[var(--color-muted)]">
                        {item.rationale}
                      </p>
                      {service?.hint && (
                        <p className="mt-1.5 text-[13px] text-[var(--color-dim)]">
                          {service.hint}
                        </p>
                      )}
                      {service?.url && (
                        <a
                          href={service.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mt-1 inline-block text-[13px] text-[var(--color-alive)] underline underline-offset-4"
                        >
                          Open the cancellation page →
                        </a>
                      )}

                      {service?.cancelledAt && (
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-edge)] pt-2">
                          {service.stillBilling ? (
                            <span className="text-xs font-medium text-[var(--color-unsure)]">
                              Billed again since {shortDate(service.cancelledAt)} — still
                              counting toward your monthly total
                            </span>
                          ) : (
                            <span className="text-xs text-[var(--color-alive)]">
                              Cancelled {shortDate(service.cancelledAt)} — no longer counted
                            </span>
                          )}
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              startTransition(async () => {
                                await undoCancellationAction(item.merchantKey);
                              })
                            }
                            className="text-xs text-[var(--color-dim)] underline underline-offset-4 hover:text-[var(--color-muted)] disabled:opacity-50"
                          >
                            Not cancelled after all
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Step>
      )}

      {toDecide.length > 0 && (
        <Step
          n={++step}
          title={`Decide on ${toDecide.length === 1 ? "this one" : `these ${toDecide.length}`}`}
          note={atStakeTotal > 0 ? `${inr(atStakeTotal)} at stake` : undefined}
          tone="text-[var(--color-unsure)]"
        >
          <ul className="flex flex-col gap-1.5">
            {toDecide.map((item) => {
              const service = services[item.merchantKey];
              return (
                <li key={item.merchantKey} className="text-[13px]">
                  <span className="font-medium">{service?.name ?? item.merchantKey}</span>
                  <span className="tnum ml-2 text-[var(--color-muted)]">
                    {inr(service?.monthlyAmount ?? 0)}/mo
                  </span>
                  {(service?.atStake ?? 0) > 0 && (
                    <span className="tnum ml-2 text-[var(--color-unsure)]">
                      {inr(service!.atStake)} at stake
                    </span>
                  )}
                  <p className="mt-0.5 text-[var(--color-muted)]">{item.rationale}</p>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-[var(--color-dim)]">
            Answer these in the list above — each row has a Yes / No you can change later.
          </p>
        </Step>
      )}

      {toKeep.length > 0 && (
        <Step
          n={++step}
          title={`Keep ${toKeep.length === 1 ? "this one" : `these ${toKeep.length}`}`}
          tone="text-[var(--color-alive)]"
        >
          <ul className="flex flex-col gap-1">
            {toKeep.map((item) => {
              const service = services[item.merchantKey];
              return (
                <li key={item.merchantKey} className="text-[13px]">
                  <span className="font-medium">{service?.name ?? item.merchantKey}</span>
                  <span className="tnum ml-2 text-[var(--color-muted)]">
                    {inr(service?.monthlyAmount ?? 0)}/mo
                  </span>
                  <span className="ml-2 text-[var(--color-muted)]">— {item.rationale}</span>
                </li>
              );
            })}
          </ul>
        </Step>
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
              Accept this plan
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
              className={`text-sm font-medium ${accepted ? "text-[var(--color-alive)]" : "text-[var(--color-muted)]"}`}
            >
              {accepted ? "Plan accepted." : "Plan set aside."}
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

/** One numbered step, with its own heading and money line. */
function Step({
  n,
  title,
  note,
  tone,
  children,
}: {
  n: number;
  title: string;
  note?: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <h3 className="flex items-baseline gap-2 text-sm font-semibold">
          <span
            className={`tnum flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-panel-2)] text-xs ${tone}`}
          >
            {n}
          </span>
          {title}
        </h3>
        {note && <span className={`tnum text-xs ${tone}`}>{note}</span>}
      </div>
      {children}
    </section>
  );
}
