"use client";

import { useTransition } from "react";
import { answerAction, clearAnswerAction } from "@/app/actions";
import { inr } from "@/lib/format";
import type { UsageVerdict } from "@/lib/types";

/**
 * Demo beat five, and the user's right of reply.
 *
 * This began as a question shown only for services the engine could not judge,
 * and only until they were answered once. Both limits were wrong.
 *
 * Only-until-answered made the first answer permanent: a mis-tapped "No, I
 * don't" prices an entire charge chain as waste with no way back, on a screen
 * whose whole argument is that its numbers can be trusted. So the control stays
 * put, shows what was chosen, and can be changed or cleared.
 *
 * Only-for-unknowns meant a confident inference could not be contradicted.
 * PRD section 6 promises the opposite -- "I can reject a verdict I disagree with
 * and have that correction persist" -- and the engine has always honoured a user
 * answer in both directions. It just had no way in.
 *
 * Clearing is not the same as answering "yes". It discards the override so the
 * evidence speaks again, which is the only way back to a verdict the user can
 * see the working for.
 */
export function UsageTick({ verdict }: { verdict: UsageVerdict }) {
  const [pending, startTransition] = useTransition();
  const answered = verdict.evidence.userAnswer;

  // Unknowable AND unanswered is the honest-refusal case, and gets the amber
  // treatment. Everything else is a quieter override on a verdict that already
  // stands on evidence.
  const isOpenQuestion = verdict.verdict === "unknown" && answered === undefined;

  const submit = (used: boolean) =>
    startTransition(async () => {
      await answerAction(verdict.merchantKey, used);
    });

  const clear = () =>
    startTransition(async () => {
      await clearAnswerAction(verdict.merchantKey);
    });

  const question = verdict.question ?? `Are you still using ${verdict.merchant}?`;

  return (
    <div
      className={`flex flex-wrap items-center gap-4 rounded-lg p-4 ${
        isOpenQuestion
          ? "border border-[var(--color-unsure)]/30 bg-[var(--color-unsure-dim)]"
          : "bg-[var(--color-panel-2)]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{question}</p>
        <p className="mt-1 text-xs text-[var(--color-dim)]">
          {isOpenQuestion && verdict.potentialWaste > 0 ? (
            <>
              <span className="tnum text-[var(--color-unsure)]">
                {inr(verdict.potentialWaste)}
              </span>{" "}
              riding on the answer — until you tell us, it counts for nothing
            </>
          ) : answered ? (
            <>
              You said {answered.used ? "you still use it" : "you don't use it"} — this
              overrides what the evidence suggests
            </>
          ) : (
            "Your answer overrides our inference, in either direction"
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          aria-pressed={answered?.used === true}
          onClick={() => submit(true)}
          className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
            answered?.used === true
              ? "border-[var(--color-alive)] bg-[var(--color-alive-dim)] text-[var(--color-alive)]"
              : "border-[var(--color-edge)] bg-[var(--color-panel)] hover:border-[var(--color-alive)] hover:text-[var(--color-alive)]"
          }`}
        >
          Yes, I use it
        </button>
        <button
          type="button"
          disabled={pending}
          aria-pressed={answered?.used === false}
          onClick={() => submit(false)}
          className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
            answered?.used === false
              ? "border-[var(--color-zombie)] bg-[var(--color-zombie-dim)] text-[var(--color-zombie)]"
              : "border-[var(--color-edge)] bg-[var(--color-panel)] hover:border-[var(--color-zombie)] hover:text-[var(--color-zombie)]"
          }`}
        >
          No, I don&apos;t
        </button>
        {answered && (
          <button
            type="button"
            disabled={pending}
            onClick={clear}
            className="text-xs text-[var(--color-dim)] underline underline-offset-4 hover:text-[var(--color-muted)] disabled:opacity-50"
          >
            {pending ? "Saving…" : "Clear"}
          </button>
        )}
      </div>
    </div>
  );
}
