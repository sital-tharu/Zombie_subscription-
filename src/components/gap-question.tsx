"use client";

import { useState, useTransition } from "react";
import { answerAction } from "@/app/actions";
import { inr } from "@/lib/format";
import type { UsageVerdict } from "@/lib/types";

/**
 * Demo beat five: the agent asks a question it genuinely cannot answer, and the
 * answer sticks.
 *
 * The amount at stake is shown next to the question on purpose. It makes the
 * cost of not knowing explicit, and it is the number that moves the headline
 * the moment the user answers.
 */
export function GapQuestion({ verdict }: { verdict: UsageVerdict }) {
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState<boolean | null>(null);

  const submit = (used: boolean) => {
    setChosen(used);
    startTransition(async () => {
      await answerAction(verdict.merchantKey, used);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-4 sm:p-5">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{verdict.merchant}</div>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{verdict.question}</p>
      </div>

      <div className="text-right text-sm">
        <div className="tnum text-[var(--color-unsure)]">{inr(verdict.potentialWaste)}</div>
        <div className="text-xs text-[var(--color-dim)]">riding on the answer</div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => submit(true)}
          className="rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-alive)] hover:text-[var(--color-alive)] disabled:opacity-50"
        >
          {pending && chosen === true ? "Saving…" : "Yes, I use it"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => submit(false)}
          className="rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-zombie)] hover:text-[var(--color-zombie)] disabled:opacity-50"
        >
          {pending && chosen === false ? "Saving…" : "No, I don't"}
        </button>
      </div>
    </div>
  );
}
