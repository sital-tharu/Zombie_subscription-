import { UsageTick } from "@/components/usage-tick";
import {
  confidenceLabel,
  dayMonth,
  daysAgoLabel,
  inr,
  monthsLabel,
  shortDate,
  sourceTheme,
  verdictLabel,
  verdictTheme,
} from "@/lib/format";
import type { UsageVerdict } from "@/lib/types";

/**
 * One subscription as a two-line row, with its evidence chain one click away.
 *
 * Built on native <details>, so expanding costs no client JavaScript and cannot
 * fail on stage. This is demo beat four: the claim that the agent is not a
 * black box is only worth making if the proof is genuinely one interaction
 * away.
 *
 * The collapsed row answers "what am I paying, where did it come from, and am I
 * using it?" and nothing else -- the reason sentence, the confidence grade and
 * the full chain all live in the body. The verdict survives the collapse three
 * ways over: the avatar's colour, the word beside the figure, and the badge
 * chip. No row can read as a bare tracker line.
 */
export function VerdictCard({
  verdict,
  sources,
}: {
  verdict: UsageVerdict;
  /** Where this subscription's charges came from: "Demo", "Receipt", "Email". */
  sources: string[];
}) {
  const theme = verdictTheme(verdict.verdict);
  const { evidence } = verdict;
  const ended = verdict.status === "ended";
  // Declared cancelled AND it took. A cancellation contradicted by a later
  // charge is not a cancellation, however firmly it was asserted.
  const stillBilling = (verdict.cancellation?.chargedSince.length ?? 0) > 0;
  const cancelled = verdict.cancellation !== undefined && !stillBilling;
  const wastedIds = new Set(verdict.wastedCharges.map((c) => c.id));

  return (
    <details className="group overflow-hidden rounded-lg bg-[var(--color-panel)]">
      <summary className="flex items-center gap-2.5 px-3.5 py-2.5">
        <svg
          className="chev size-3 shrink-0 text-[var(--color-dim)]"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        {/* Tinted by verdict rather than by merchant. Rupee Radar colours this
            circle per-merchant because it has no verdict to show; here the
            verdict is the point, and a second unrelated colour would compete
            with it. */}
        <span
          aria-hidden="true"
          className={`flex size-8 shrink-0 items-center justify-center rounded-full text-[15px] font-bold ${theme.chipBg} ${theme.text}`}
        >
          {verdict.merchant.trim().charAt(0).toUpperCase()}
        </span>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-medium">
            {verdict.merchant}
            {cancelled ? (
              <span className="shrink-0 rounded bg-[var(--color-alive-dim)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-alive)] uppercase">
                Cancelled
              </span>
            ) : (
              ended && (
                <span className="shrink-0 rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
                  Ended
                </span>
              )
            )}
            {stillBilling && (
              <span className="shrink-0 rounded bg-[var(--color-unsure-dim)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-unsure)] uppercase">
                Still billing
              </span>
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--color-muted)]">
            {ended ? (
              // Never "next 22 May" for a chain that stopped in March -- the
              // projection is in the past and would read as a coming charge.
              <>
                <span>
                  {shortDate(evidence.firstDate)} – {shortDate(evidence.lastDate)}
                </span>
                <span aria-hidden="true">·</span>
                {sources.map((source) => (
                  <SourceBadge key={source} label={source} />
                ))}
                <span aria-hidden="true">·</span>
                <span>last charge {evidence.daysSinceLastCharge} days ago</span>
              </>
            ) : (
              <>
                <span>since {shortDate(evidence.firstDate)}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {evidence.chargeCount} {evidence.chargeCount === 1 ? "month" : "months"}
                </span>
                <span aria-hidden="true">·</span>
                {sources.map((source) => (
                  <SourceBadge key={source} label={source} />
                ))}
                <span aria-hidden="true">·</span>
                <span>next {dayMonth(verdict.nextCharge)}</span>
              </>
            )}
          </p>
          {verdict.cancellation ? (
            <p className="mt-0.5 text-xs text-[var(--color-dim)]">
              {stillBilling ? (
                <span className="text-[var(--color-unsure)]">
                  you marked this cancelled on{" "}
                  {shortDate(verdict.cancellation.cancelledAt)}, but it billed again on{" "}
                  {shortDate(
                    verdict.cancellation.chargedSince[
                      verdict.cancellation.chargedSince.length - 1
                    ].date,
                  )}
                </span>
              ) : (
                <>cancelled {shortDate(verdict.cancellation.cancelledAt)} — no longer counted</>
              )}
            </p>
          ) : (
            ended && (
              <p className="mt-0.5 text-xs text-[var(--color-dim)]">
                appears cancelled — not counted in savings
              </p>
            )
          )}
        </div>

        <div className="shrink-0 text-right">
          <p className="tnum text-sm font-medium">{inr(verdict.monthlyAmount)}/mo</p>
          <p className="mt-0.5 text-xs">
            {verdict.zombieScore > 0 ? (
              <span className={theme.text}>
                <span className="tnum font-medium">{inr(verdict.zombieScore)}</span> wasted
              </span>
            ) : verdict.potentialWaste > 0 ? (
              <span className="text-[var(--color-unsure)]">
                <span className="tnum">{inr(verdict.potentialWaste)}</span> at stake
              </span>
            ) : (
              <span className={theme.text}>{verdictLabel(verdict.verdict)}</span>
            )}
          </p>
        </div>
      </summary>

      <div className="border-t border-[var(--color-edge)] px-3.5 py-4">
        {/* The badges PLAN.md puts in the ranked list, and the reason sentence,
            both demoted from the row to here. They are the argument; the row is
            the orientation. */}
        <div className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-md ${theme.chipBg} ${theme.text} px-2 py-0.5 text-[11px] font-medium`}
            >
              {verdictLabel(verdict.verdict)}
            </span>
            <span className="rounded-md bg-[var(--color-panel-2)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
              {confidenceLabel(verdict.confidence)}
            </span>
          </div>
          <p className="mt-2 text-[13px] text-[var(--color-muted)]">{verdict.reason}</p>
        </div>

        {/* Every subscription, not just the unjudgeable ones. The engine has
            always honoured an answer in both directions; this is the way in. */}
        <div className="mb-5">
          <UsageTick verdict={verdict} />
        </div>

        <h3 className="mb-3 font-mono text-[11px] tracking-widest text-[var(--color-dim)] uppercase">
          Evidence chain
        </h3>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* What we looked for, and what came back. */}
          <section className="space-y-2.5 text-[13px]">
            {evidence.footprint === "transaction" ? (
              <>
                <Row label="Looked for">
                  <span className="text-[var(--color-fg)]">{evidence.usageLabel}</span>
                  <span className="ml-2 text-[var(--color-dim)]">
                    matching {evidence.searchedPatterns.map((p) => `"${p}"`).join(", ")}
                  </span>
                </Row>
                <Row label="Window">
                  {shortDate(evidence.windowStart)} — {shortDate(evidence.windowEnd)}
                  <span className="ml-2 text-[var(--color-dim)]">
                    ({evidence.lookbackDays} days)
                  </span>
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
                {/* Layer 2b. Shown as its own row, and only when there is mail
                    to report on, so a user without Gmail connected is never
                    told about a source that contributed nothing. */}
                {(evidence.emailMatchesInWindow.length > 0 || evidence.lastEmailUsage) && (
                  <Row label="In your inbox">
                    {evidence.emailMatchesInWindow.length > 0 ? (
                      <span className="text-[var(--color-alive)]">
                        {evidence.emailMatchesInWindow.length} confirmation{" "}
                        {evidence.emailMatchesInWindow.length === 1 ? "email" : "emails"}
                      </span>
                    ) : (
                      <span className="text-[var(--color-muted)]">
                        none in the window
                      </span>
                    )}
                    {evidence.lastEmailUsage && (
                      <span className="ml-2 text-[var(--color-dim)]">
                        — latest &ldquo;{evidence.lastEmailUsage.subject}&rdquo;,{" "}
                        {shortDate(evidence.lastEmailUsage.date)}
                      </span>
                    )}
                  </Row>
                )}
                <Row label="Last usage">
                  {evidence.lastUsage || evidence.lastEmailUsage ? (
                    <>
                      {shortDate(
                        // Whichever source is later -- the same figure that
                        // bounds the score.
                        [evidence.lastUsage?.date, evidence.lastEmailUsage?.date]
                          .filter((d): d is string => typeof d === "string")
                          .sort()
                          .pop()!,
                      )}
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

            {ended ? (
              <Row label="Status">
                <span className="text-[var(--color-fg)]">Appears cancelled</span>
                <span className="ml-2 text-[var(--color-dim)]">
                  nothing billed for {evidence.daysSinceLastCharge} days, so no future
                  savings are counted — the waste it already caused still is
                </span>
              </Row>
            ) : (
              <Row label="Next charge">
                <span className="text-[var(--color-fg)]">{shortDate(verdict.nextCharge)}</span>
                <span className="ml-2 text-[var(--color-dim)]">
                  projected — last charge plus the usual gap
                </span>
              </Row>
            )}

            {evidence.userAnswer && (
              <Row label="Your answer">
                <span className="text-[var(--color-fg)]">
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
            <div className="mb-2 flex items-baseline justify-between text-[13px]">
              <span className="text-[var(--color-muted)]">
                {evidence.chargeCount} charges since {shortDate(evidence.firstDate)}
                <span className="text-[var(--color-dim)]"> · {monthsLabel(evidence.spanDays)}</span>
              </span>
              <span className="tnum text-[var(--color-muted)]">
                {inr(evidence.totalPaid)} total
              </span>
            </div>
            <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-lg border border-[var(--color-edge)]">
              {[...evidence.charges].reverse().map((charge) => {
                const wasted = wastedIds.has(charge.id);
                return (
                  <li
                    key={charge.id}
                    className={`flex items-center gap-3 px-3 py-1.5 text-[13px] ${wasted ? "bg-[var(--color-zombie-dim)]" : ""}`}
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${wasted ? "bg-[var(--color-zombie)]" : "bg-[var(--color-edge)]"}`}
                    />
                    <span className="tnum w-24 shrink-0 text-[var(--color-muted)]">
                      {shortDate(charge.date)}
                    </span>
                    <span className="tnum w-20 shrink-0 text-right">{inr(charge.amount)}</span>
                    <span className="truncate font-mono text-[11px] text-[var(--color-dim)]">
                      {charge.id}
                    </span>
                    {wasted && (
                      <span className="ml-auto shrink-0 text-[11px] text-[var(--color-zombie)]">
                        counted
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {verdict.zombieScore > 0 && (
              <p className="mt-2 text-right text-[13px] text-[var(--color-muted)]">
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

/**
 * Where a charge chain came from. Deliberately plain: this is provenance, not a
 * verdict, so it never borrows the verdict palette.
 */
export function SourceBadge({ label }: { label: string }) {
  const theme = sourceTheme(label);
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${theme.bg} ${theme.text}`}
    >
      {label}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-[var(--color-dim)]">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
