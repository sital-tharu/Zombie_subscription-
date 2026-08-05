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
 *
 * Rendered inside a verdict card's body rather than in a section of its own.
 * The standalone section listed Netflix and KUKU FM a second time on a screen
 * that already showed them, which is a real cost on a page whose job is to be
 * scannable. The beat is not lost: the count and the amount at stake are
 * promoted to the header band, above the fold, where the section never was.
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
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-[var(--color-unsure)]/30 bg-[var(--color-unsure-dim)] p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{verdict.question}</p>
        <p className="mt-1 text-xs text-[var(--color-dim)]">
          <span className="tnum text-[var(--color-unsure)]">{inr(verdict.potentialWaste)}</span>{" "}
          riding on the answer — until you tell us, it counts for nothing
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => submit(true)}
          className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-alive)] hover:text-[var(--color-alive)] disabled:opacity-50"
        >
          {pending && chosen === true ? "Saving…" : "Yes, I use it"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => submit(false)}
          className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-zombie)] hover:text-[var(--color-zombie)] disabled:opacity-50"
        >
          {pending && chosen === false ? "Saving…" : "No, I don't"}
        </button>
      </div>
    </div>
  );
}
