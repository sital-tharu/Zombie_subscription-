import {
  confidenceLabel,
  daysAgoLabel,
  inr,
  shortDate,
  verdictLabel,
  verdictTheme,
} from "@/lib/format";
import type { UsageVerdict } from "@/lib/types";

/**
 * One subscription, with its evidence chain one click away.
 *
 * Built on native <details>, so expanding costs no client JavaScript and cannot
 * fail on stage. This is demo beat four: the claim that the agent is not a
 * black box is only worth making if the proof is genuinely one interaction
 * away.
 */
export function VerdictCard({ verdict }: { verdict: UsageVerdict }) {
  const theme = verdictTheme(verdict.verdict);
  const { evidence } = verdict;
  const wastedIds = new Set(verdict.wastedCharges.map((c) => c.id));

  return (
    <details className={`group rounded-xl border border-[var(--color-edge)] border-l-4 ${theme.border} bg-[var(--color-panel)] transition-colors hover:bg-[var(--color-panel-2)]`}>
      <summary className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 sm:p-5">
        <svg
          className="chev size-4 shrink-0 text-[var(--color-dim)]"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-base font-semibold sm:text-lg">{verdict.merchant}</span>
            <span className={`rounded-full ${theme.chipBg} ${theme.text} px-2.5 py-0.5 text-xs font-medium`}>
              {verdictLabel(verdict.verdict)}
            </span>
            <span className="rounded-full bg-[var(--color-panel-2)] px-2.5 py-0.5 text-xs text-[var(--color-muted)]">
              {confidenceLabel(verdict.confidence)}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">{verdict.reason}</p>
        </div>

        <div className="ml-auto text-right">
          {verdict.zombieScore > 0 ? (
            <>
              <div className={`tnum text-xl font-semibold sm:text-2xl ${theme.text}`}>
                {inr(verdict.zombieScore)}
              </div>
              <div className="text-xs text-[var(--color-dim)]">wasted so far</div>
            </>
          ) : verdict.potentialWaste > 0 ? (
            <>
              <div className="tnum text-lg font-medium text-[var(--color-muted)]">
                {inr(verdict.potentialWaste)}
              </div>
              <div className="text-xs text-[var(--color-dim)]">at stake</div>
            </>
          ) : (
            <>
              <div className="tnum text-lg font-medium text-[var(--color-muted)]">
                {inr(verdict.monthlyAmount)}
              </div>
              <div className="text-xs text-[var(--color-dim)]">per month</div>
            </>
          )}
        </div>
      </summary>

      <div className="border-t border-[var(--color-edge)] px-4 py-5 sm:px-5">
        <h3 className="mb-4 text-xs font-semibold tracking-widest text-[var(--color-dim)] uppercase">
          Evidence chain
        </h3>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* What we looked for, and what came back. */}
          <section className="space-y-3 text-sm">
            {evidence.footprint === "transaction" ? (
              <>
                <Row label="Looked for">
                  <span className="text-[#e9edf5]">{evidence.usageLabel}</span>
                  <span className="ml-2 text-[var(--color-dim)]">
                    matching {evidence.searchedPatterns.map((p) => `"${p}"`).join(", ")}
                  </span>
                </Row>
                <Row label="Window">
                  {shortDate(evidence.windowStart)} — {shortDate(evidence.windowEnd)}
                  <span className="ml-2 text-[var(--color-dim)]">({evidence.lookbackDays} days)</span>
                </Row>
                <Row label="Found in window">
                  {evidence.matchesInWindow.length > 0 ? (
                    <span className="text-[var(--color-alive)]">
                      {evidence.matchesInWindow.length}{" "}
                      {evidence.matchesInWindow.length === 1 ? "transaction" : "transactions"}
                    </span>
                  ) : (
                    <span className="text-[var(--color-zombie)]">nothing</span>
                  )}
                </Row>
                <Row label="Last usage">
                  {evidence.lastUsage ? (
                    <>
                      {shortDate(evidence.lastUsage.date)}
                      <span className="ml-2 text-[var(--color-dim)]">
                        {daysAgoLabel(evidence.daysSinceLastUsage)}
                      </span>
                    </>
                  ) : (
                    <span className="text-[var(--color-zombie)]">never seen</span>
                  )}
                </Row>
              </>
            ) : (
              <div className="rounded-lg bg-[var(--color-unsure-dim)] p-3 text-[var(--color-muted)]">
                {evidence.footprint === "none"
                  ? "This service leaves no separate charge when you use it, so there is nothing in your transaction history to search. Silence here is not evidence of disuse — it is what using it looks like."
                  : "This merchant is not in our map, so we do not know what using it would look like. Rather than guess, we ask."}
                <div className="mt-2 text-[var(--color-dim)]">
                  No claim is made and no money is counted against this subscription.
                </div>
              </div>
            )}

            {evidence.userAnswer && (
              <Row label="Your answer">
                <span className="text-[#e9edf5]">
                  {evidence.userAnswer.used ? "Still using it" : "No longer using it"}
                </span>
                <span className="ml-2 text-[var(--color-dim)]">
                  — your answer overrides our inference
                </span>
              </Row>
            )}
          </section>

          {/* Every charge, and exactly which ones the figure is made of. */}
          <section>
            <div className="mb-2 flex items-baseline justify-between text-sm">
              <span className="text-[var(--color-muted)]">
                {evidence.chargeCount} charges since {shortDate(evidence.firstDate)}
              </span>
              <span className="tnum text-[var(--color-muted)]">{inr(evidence.totalPaid)} total</span>
            </div>
            <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-lg border border-[var(--color-edge)]">
              {[...evidence.charges].reverse().map((charge) => {
                const wasted = wastedIds.has(charge.id);
                return (
                  <li
                    key={charge.id}
                    className={`flex items-center gap-3 px-3 py-2 text-sm ${wasted ? "bg-[var(--color-zombie-dim)]/40" : ""}`}
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${wasted ? "bg-[var(--color-zombie)]" : "bg-[var(--color-edge)]"}`} />
                    <span className="tnum w-24 shrink-0 text-[var(--color-muted)]">
                      {shortDate(charge.date)}
                    </span>
                    <span className="tnum w-20 shrink-0 text-right">{inr(charge.amount)}</span>
                    <span className="truncate font-mono text-xs text-[var(--color-dim)]">
                      {charge.id}
                    </span>
                    {wasted && (
                      <span className="ml-auto shrink-0 text-xs text-[var(--color-zombie)]">
                        counted
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {verdict.zombieScore > 0 && (
              <p className="mt-2 text-right text-sm text-[var(--color-muted)]">
                <span className="tnum text-[var(--color-zombie)]">{inr(verdict.zombieScore)}</span>{" "}
                = the {verdict.wastedCharges.length} highlighted{" "}
                {verdict.wastedCharges.length === 1 ? "charge" : "charges"}
              </p>
            )}
          </section>
        </div>
      </div>
    </details>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-32 shrink-0 text-[var(--color-dim)]">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
