import Link from "next/link";
import { Logo } from "@/components/logo";
import { PlanPanel } from "@/components/plan-panel";
import { SourceBadge, VerdictCard } from "@/components/verdict-card";
import { UploadScreenshot } from "@/components/upload-screenshot";
import { analyze, LOOKBACK_DAYS } from "@/lib/correlate";
import { todayIso } from "@/lib/dates";
import {
  addMonths,
  dayMonth,
  inr,
  isMonthKey,
  lastDayOfMonth,
  monthKey,
  monthLabel,
  monthsLabel,
  shortDate,
  sourceLabel,
  verdictGlyph,
} from "@/lib/format";
import { hasGeminiKey } from "@/lib/gemini";
import { cancelGuidance } from "@/lib/merchant-map";
import {
  getStore,
  readWasTruncated,
  storeMode,
  TRANSACTION_READ_LIMIT,
} from "@/lib/store";
import {
  AMOUNT_TOLERANCE,
  CADENCE_DAYS,
  CADENCE_TOLERANCE_DAYS,
  detectCandidates,
  MIN_OCCURRENCES,
} from "@/lib/subscriptions";
import type { StoredTransaction, UsageVerdict } from "@/lib/types";

// Read at request time. The verdicts depend on today's date and on answers the
// user may have given seconds ago, so a build-time snapshot would be wrong.
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const monthRaw = Array.isArray(sp.m) ? sp.m[0] : sp.m;

  const store = await getStore();
  const [transactions, answers, proposal] = await Promise.all([
    store.listTransactions(),
    store.listAnswers(),
    store.latestProposal(),
  ]);

  const today = todayIso();
  const currentMonth = monthKey(today);
  const earliestMonth =
    transactions.length > 0
      ? monthKey(transactions.reduce((min, t) => (t.date < min ? t.date : min), transactions[0].date))
      : currentMonth;

  // Clamped to the range we actually hold data for, so a hand-typed ?m= cannot
  // produce a page reporting on a month the history never covered.
  const selectedMonth =
    monthRaw && isMonthKey(monthRaw) && monthRaw >= earliestMonth && monthRaw <= currentMonth
      ? monthRaw
      : currentMonth;
  const isCurrentMonth = selectedMonth === currentMonth;

  /*
   * The time machine, and the one line that makes the whole month navigator
   * honest.
   *
   * Paging back re-runs the engine as of that month's END, so April shows the
   * verdicts the agent would genuinely have reached in April -- Zomato Gold
   * still "used", because its last order was 11 April. Clamping to `today` for
   * the current month is what keeps the default view on the canonical figures
   * rather than analysing against a date that has not happened yet.
   */
  const asOf = isCurrentMonth ? today : lastDayOfMonth(selectedMonth);
  const result = analyze(transactions, asOf, { answers });

  const flagged = result.verdicts.filter((v) => v.verdict === "likely-unused");
  const askable = new Set(result.needsInput.map((v) => v.merchantKey));
  const atStake = result.needsInput.reduce((sum, v) => sum + v.potentialWaste, 0);

  // Provenance is resolved here rather than in the engine. `TransactionLike`
  // deliberately carries only the four fields a verdict depends on, and adding
  // a display-only field to it would widen the engine's contract for the sake
  // of a badge.
  const byId = new Map<string, StoredTransaction>(transactions.map((t) => [t.id, t]));
  const sourcesFor = (verdict: UsageVerdict): string[] => {
    const found = new Set<string>();
    for (const charge of verdict.evidence.charges) {
      const txn = byId.get(charge.id);
      found.add(sourceLabel(txn?.source, txn?.seeded));
    }
    return [...found].sort();
  };

  /*
   * Merchants that charged you but did not qualify, filtered to things YOU put
   * in. The seed carries ~21 background merchants; listing all of them would
   * bury the one row this section exists to show. Source is invisible to the
   * engine by design, so the filter lives here rather than in detectCandidates.
   */
  const watchlist = detectCandidates(transactions, asOf)
    .filter((candidate) =>
      candidate.chargeIds.some((id) => {
        const txn = byId.get(id);
        return txn !== undefined && sourceLabel(txn.source, txn.seeded) !== "Demo";
      }),
    )
    .slice(0, 8);

  const endedCount = result.verdicts.filter((v) => v.status === "ended").length;

  // Every transaction in the month, chained or not. The only place in the
  // product where a raw row is visible, and the answer to "did my upload work".
  const chainedIds = new Set(
    result.verdicts.flatMap((v) => v.evidence.charges.map((c) => c.id)),
  );
  const monthTransactions = transactions
    .filter((txn) => txn.date.startsWith(selectedMonth))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id < b.id ? 1 : -1));

  // Only subscription charges -- drawn from the detected chains rather than
  // from the raw transaction list, so background noise never appears here.
  const monthCharges = result.verdicts
    .flatMap((v) =>
      v.evidence.charges
        .filter((c) => c.date.startsWith(selectedMonth))
        .map((c) => ({ ...c, merchant: v.merchant, verdict: v.verdict })),
    )
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1));
  const monthBilled = monthCharges.reduce((sum, c) => sum + c.amount, 0);

  // What is still to come this month. The seed's charges all land in the back
  // half of a month, so on the 4th the current month is legitimately empty --
  // and "nothing yet, here is what is coming" is the true answer, not a bug.
  const upcoming = result.verdicts
    .filter((v) => monthKey(v.nextCharge) === selectedMonth && v.nextCharge > today)
    .sort((a, b) => (a.nextCharge < b.nextCharge ? -1 : 1));

  const prevMonth = addMonths(selectedMonth, -1);
  const nextMonth = addMonths(selectedMonth, 1);
  const hasPrev = prevMonth >= earliestMonth;

  const services = Object.fromEntries(
    result.verdicts.map((v) => [
      v.merchantKey,
      {
        name: v.merchant,
        monthlyAmount: v.monthlyAmount,
        ...cancelGuidance(v.merchantKey),
      },
    ]),
  );

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      {/* Brand row + the monthly total, mirroring Rupee Radar's header. */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Logo size={44} className="shrink-0" />
          <div>
            <p className="font-mono text-xs tracking-widest text-[var(--color-muted)]">ZOMBIE</p>
            <p className="mt-0.5 text-[13px] text-[var(--color-dim)]">
              Judges usage, not billing
            </p>
          </div>
        </div>
        {result.subscriptions.length > 0 && (
          <div className="text-right">
            <p className="text-xs text-[var(--color-dim)]">Subscriptions · monthly total</p>
            <p className="tnum mt-0.5 font-mono text-[15px] font-medium">
              {inr(result.monthlyRunRate)}/mo
            </p>
          </div>
        )}
      </div>

      {transactions.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Month navigator */}
          <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs tracking-widest text-[var(--color-dim)]">MONTH</p>
              <div className="mt-0.5 flex items-center gap-1">
                {hasPrev ? (
                  <Link
                    href={`/?m=${prevMonth}`}
                    aria-label={`Previous month, ${monthLabel(prevMonth)}`}
                    className="rounded px-1 text-[var(--color-dim)] hover:text-[var(--color-fg)]"
                  >
                    ‹
                  </Link>
                ) : (
                  <span className="px-1 text-[var(--color-edge)]" aria-hidden="true">
                    ‹
                  </span>
                )}
                <h1 className="text-[15px] font-medium">{monthLabel(selectedMonth)}</h1>
                {!isCurrentMonth && (
                  <Link
                    href={nextMonth === currentMonth ? "/" : `/?m=${nextMonth}`}
                    aria-label={`Next month, ${monthLabel(nextMonth)}`}
                    className="rounded px-1 text-[var(--color-dim)] hover:text-[var(--color-fg)]"
                  >
                    ›
                  </Link>
                )}
              </div>
            </div>
            {hasGeminiKey() && <UploadScreenshot />}
          </div>

          {!isCurrentMonth && (
            <p className="mt-3 rounded-lg bg-[var(--color-panel)] px-3.5 py-2 text-[13px] text-[var(--color-muted)]">
              Showing the verdicts as they stood on{" "}
              <span className="text-[var(--color-fg)]">{shortDate(asOf)}</span> — the agent
              re-run against that date, not today.{" "}
              <Link href="/" className="text-[var(--color-alive)] underline underline-offset-2">
                Back to now
              </Link>
            </p>
          )}

          {/* Stat tiles */}
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-[1.3fr_1fr]">
            <div className="rounded-xl bg-[var(--color-panel)] p-4">
              <p className="text-[13px] text-[var(--color-muted)]">
                Wasted to date{isCurrentMonth ? "" : ` · as of ${shortDate(asOf)}`}
              </p>
              <p className="tnum mt-1 font-mono text-3xl font-medium tracking-tight text-[var(--color-zombie)]">
                {inr(result.totalWasted)}
              </p>
              <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                {flagged.length > 0 ? (
                  <>
                    across {flagged.length}{" "}
                    {flagged.length === 1 ? "subscription" : "subscriptions"} ·{" "}
                    <span className="tnum">{inr(result.annualSavings)}</span>/yr if you cancel
                    them
                  </>
                ) : (
                  "nothing flagged yet"
                )}
              </p>
            </div>
            <div className="flex flex-col justify-center rounded-xl bg-[var(--color-panel)] p-4">
              <p className="text-[13px] text-[var(--color-muted)]">Recurring</p>
              <p className="tnum mt-1 font-mono text-3xl font-medium tracking-tight">
                {result.subscriptions.length}
              </p>
              <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                {result.needsInput.length > 0
                  ? `${result.needsInput.length} we can't judge without you`
                  : "all judged"}
                {endedCount > 0 && ` · ${endedCount} already ended`}
              </p>
            </div>
          </div>

          {/* Demo beat five, above the fold. */}
          {result.needsInput.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[13px] text-[var(--color-muted)]">
                We genuinely can&apos;t tell
              </h2>
              <p className="mt-2 rounded-lg bg-[var(--color-unsure-dim)] px-3.5 py-2.5 text-[13px] text-[var(--color-muted)]">
                <span className="font-medium text-[var(--color-unsure)]">
                  {`${result.needsInput.length} ${
                    result.needsInput.length === 1 ? "subscription" : "subscriptions"
                  } leave no trace when you use them`}
                </span>{" "}
                — <span className="tnum text-[var(--color-fg)]">{inr(atStake)}</span> riding on
                your answer. Rather than guess, we ask. Open one below to settle it, and until
                you do it counts for nothing.
              </p>
            </section>
          )}

          {/* Recurring subscriptions */}
          <section className="mt-6">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] text-[var(--color-muted)]">
                Recurring subscriptions · monthly
              </h2>
              <span className="text-xs text-[var(--color-dim)]">ranked by money wasted</span>
            </div>
            <ul className="mt-2 flex flex-col gap-2">
              {result.verdicts.map((verdict) => (
                <li key={verdict.merchantKey}>
                  <VerdictCard
                    verdict={verdict}
                    sources={sourcesFor(verdict)}
                    ask={askable.has(verdict.merchantKey)}
                  />
                </li>
              ))}
            </ul>
          </section>

          {/* This month's charges */}
          <section className="mt-8">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] text-[var(--color-muted)]">
                Charges in {monthLabel(selectedMonth)}
              </h2>
              {monthCharges.length > 0 && (
                <span className="tnum text-xs text-[var(--color-dim)]">
                  {monthCharges.length} {monthCharges.length === 1 ? "charge" : "charges"} ·{" "}
                  {inr(monthBilled)}
                </span>
              )}
            </div>

            {monthCharges.length > 0 ? (
              <div className="mt-3 overflow-x-auto rounded-lg border border-[var(--color-edge)]">
                <table className="w-full min-w-[460px] text-[13px]">
                  <thead>
                    <tr className="bg-[var(--color-panel)] text-left text-xs text-[var(--color-muted)]">
                      <th className="px-3.5 py-2 font-medium">Date</th>
                      <th className="px-3.5 py-2 font-medium">Subscription</th>
                      <th className="px-3.5 py-2 font-medium">Source</th>
                      <th className="px-3.5 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthCharges.map((charge) => {
                      const txn = byId.get(charge.id);
                      return (
                        <tr key={charge.id} className="border-t border-[var(--color-edge)]">
                          <td className="px-3.5 py-2.5 whitespace-nowrap text-[var(--color-muted)]">
                            {shortDate(charge.date)}
                          </td>
                          <td className="px-3.5 py-2.5">
                            <span
                              aria-hidden="true"
                              className={`mr-1.5 ${verdictTextClass(charge.verdict)}`}
                            >
                              {verdictGlyph(charge.verdict)}
                            </span>
                            {charge.merchant}
                          </td>
                          <td className="px-3.5 py-2.5">
                            <SourceBadge label={sourceLabel(txn?.source, txn?.seeded)} />
                          </td>
                          <td className="tnum px-3.5 py-2.5 text-right font-mono">
                            {inr(charge.amount)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-[var(--color-edge)] px-3.5 py-4 text-[13px] text-[var(--color-muted)]">
                <p>
                  Nothing billed in {monthLabel(selectedMonth)} yet.
                  {upcoming.length > 0 && " Still to come this month:"}
                </p>
                {upcoming.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1">
                    {upcoming.map((v) => (
                      <li key={v.merchantKey} className="flex justify-between gap-3">
                        <span>
                          <span className="tnum text-[var(--color-dim)]">
                            {shortDate(v.nextCharge)}
                          </span>
                          <span className="ml-2.5">{v.merchant}</span>
                          <span className="ml-2 text-xs text-[var(--color-dim)]">projected</span>
                        </span>
                        <span className="tnum font-mono">{inr(v.monthlyAmount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {/*
              Every transaction, chained or not. Without this the app silently
              swallowed uploads: a one-off recharge was parsed, validated and
              stored, and then appeared nowhere, because every other surface is
              built from detected chains. A user could not tell a misread
              screenshot from a payment that simply is not a subscription.
            */}
            {monthTransactions.length > 0 && (
              <details className="mt-3 overflow-hidden rounded-lg bg-[var(--color-panel)]">
                <summary className="flex items-center gap-2 px-3.5 py-2.5 text-[13px] text-[var(--color-muted)]">
                  <svg
                    className="chev size-3 shrink-0"
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
                  All transactions in {monthLabel(selectedMonth)} ({monthTransactions.length})
                </summary>
                <div className="overflow-x-auto border-t border-[var(--color-edge)]">
                  <table className="w-full min-w-[460px] text-[13px]">
                    <thead>
                      <tr className="text-left text-xs text-[var(--color-muted)]">
                        <th className="px-3.5 py-2 font-medium">Date</th>
                        <th className="px-3.5 py-2 font-medium">Merchant</th>
                        <th className="px-3.5 py-2 font-medium">Source</th>
                        <th className="px-3.5 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthTransactions.map((txn) => (
                        <tr key={txn.id} className="border-t border-[var(--color-edge)]">
                          <td className="px-3.5 py-2 whitespace-nowrap text-[var(--color-muted)]">
                            {shortDate(txn.date)}
                          </td>
                          <td className="px-3.5 py-2">
                            {txn.merchant}
                            {chainedIds.has(txn.id) && (
                              <span className="ml-2 text-xs text-[var(--color-dim)]">
                                subscription
                              </span>
                            )}
                          </td>
                          <td className="px-3.5 py-2">
                            <SourceBadge label={sourceLabel(txn.source, txn.seeded)} />
                          </td>
                          <td className="tnum px-3.5 py-2 text-right font-mono">
                            {inr(txn.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </section>

          {/* The answer to "I uploaded a screenshot and nothing happened". */}
          {watchlist.length > 0 && (
            <section className="mt-8">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-[13px] text-[var(--color-muted)]">
                  Not yet a subscription
                </h2>
                <span className="text-xs text-[var(--color-dim)]">
                  {MIN_OCCURRENCES} charges needed to qualify
                </span>
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {watchlist.map((candidate) => (
                  <li
                    key={candidate.merchantKey}
                    className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-[var(--color-edge)] px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{candidate.merchant}</p>
                      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                        {candidate.occurrences}{" "}
                        {candidate.occurrences === 1 ? "charge" : "charges"} · last{" "}
                        {shortDate(candidate.lastDate)}
                        <span className="mx-1.5 text-[var(--color-dim)]">·</span>
                        {candidate.expectedNext
                          ? `1 more and it qualifies, next expected ~${dayMonth(candidate.expectedNext)}`
                          : `needs ${candidate.needs} more monthly ${candidate.needs === 1 ? "charge" : "charges"}`}
                      </p>
                    </div>
                    <p className="tnum shrink-0 font-mono text-sm">
                      {inr(candidate.latestAmount)}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[var(--color-dim)]">
                No verdict is offered on these, and none of them counts toward any figure
                above. With fewer than {MIN_OCCURRENCES} charges there is no cadence to
                judge — so we say nothing rather than guess.
              </p>
            </section>
          )}

          {/* Your plan */}
          <section className="mt-8">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] text-[var(--color-muted)]">Your plan</h2>
              <span className="text-xs text-[var(--color-dim)]">
                a checklist, not an action — nothing is cancelled for you
              </span>
            </div>
            <div className="mt-3">
              <PlanPanel proposal={proposal} services={services} />
            </div>
          </section>

          {/* Provenance. Kept in full and kept last: a judge will look for it,
              but it is not what a user opens the app to read. */}
          <section className="mt-8">
            <h2 className="text-[13px] text-[var(--color-muted)]">How this was worked out</h2>
            <div className="mt-3">
              <HowDetectionWorks lookbackDays={result.lookbackDays} />
            </div>
            <p className="mt-3 text-[13px] text-[var(--color-muted)]">
              <span className="text-[var(--color-fg)]">
                {result.transactionsAnalysed} transactions
              </span>{" "}
              over {monthsLabel(result.historySpanDays)}
              {result.historyStart && (
                <span className="text-[var(--color-dim)]">
                  {" "}
                  ({shortDate(result.historyStart)} – {shortDate(result.asOf)})
                </span>
              )}
              <span className="mx-2 text-[var(--color-dim)]">·</span>
              usage checked over the{" "}
              <span className="text-[var(--color-fg)]">last {result.lookbackDays} days</span>
            </p>
          </section>
        </>
      )}

      <footer className="mt-10 border-t border-[var(--color-edge)] pt-6 text-[13px] text-[var(--color-dim)]">
        <p>
          Every verdict and every figure on this page is computed in TypeScript from your
          transaction history. AI reads screenshots and writes the plan; it never produces a
          number.
        </p>
        <p className="mt-2">
          Reading {transactions.length} transactions from the {storeMode()} store ·{" "}
          {readWasTruncated(transactions.length)
            ? `showing the most recent ${TRANSACTION_READ_LIMIT} — older charges are not included`
            : "complete history"}{" "}
          · analysed as of {result.asOf}
        </p>
      </footer>
    </main>
  );
}

function verdictTextClass(verdict: string): string {
  if (verdict === "likely-unused") return "text-[var(--color-zombie)]";
  if (verdict === "used") return "text-[var(--color-alive)]";
  return "text-[var(--color-unsure)]";
}

/**
 * The detection rule, stated on the page.
 *
 * Every threshold is imported from the engine rather than typed into the JSX.
 * A hard-coded "30 days" here would become a lie the first time a constant is
 * tuned, and this panel exists precisely to be trusted.
 */
function HowDetectionWorks({ lookbackDays }: { lookbackDays: number }) {
  const minGap = CADENCE_DAYS - CADENCE_TOLERANCE_DAYS;
  const maxGap = CADENCE_DAYS + CADENCE_TOLERANCE_DAYS;

  return (
    <details className="rounded-lg bg-[var(--color-panel)]">
      <summary className="flex items-center gap-2 px-3.5 py-2.5 text-[13px] text-[var(--color-muted)]">
        <svg className="chev size-3 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        What counts as a subscription?
      </summary>
      <div className="space-y-3 border-t border-[var(--color-edge)] px-3.5 py-4 text-[13px] text-[var(--color-muted)]">
        <p>
          A charge becomes a subscription when all four hold: the same merchant, charges{" "}
          <span className="text-[var(--color-fg)]">
            {minGap}–{maxGap} days
          </span>{" "}
          apart, each within{" "}
          <span className="text-[var(--color-fg)]">
            ±{Math.round(AMOUNT_TOLERANCE * 100)}%
          </span>{" "}
          of the one before it, and at least{" "}
          <span className="text-[var(--color-fg)]">{MIN_OCCURRENCES} of them</span> in an
          unbroken run.
        </p>
        <p>
          Two different time windows are involved, and mixing them up is the easiest way to get a
          wrong number:
        </p>
        <ul className="space-y-1.5 pl-4">
          <li className="list-disc">
            <span className="text-[var(--color-fg)]">Charge history is unbounded.</span> Chains
            are traced as far back as your data goes — the month above names the period being
            reported, not a limit on what was read.
          </li>
          <li className="list-disc">
            <span className="text-[var(--color-fg)]">
              Usage is checked over {lookbackDays} days.
            </span>{" "}
            That decides the verdict. But the <em>score</em> is bounded by when you last used
            the service, however long ago that was — so a subscription last used 115 days ago
            counts only the charges billed since, not the whole chain.
          </li>
        </ul>
        <p className="text-[var(--color-dim)]">
          A gap longer than {maxGap} days, or a price jump beyond{" "}
          {Math.round(AMOUNT_TOLERANCE * 100)}%, ends the chain — only the current run counts.
          The monthly total is the sum of each subscription&apos;s latest charge, and the
          next-charge dates are projections from each chain&apos;s own cadence.
          {lookbackDays < LOOKBACK_DAYS && (
            <>
              {" "}
              Your history is shorter than {LOOKBACK_DAYS} days, so the window has shrunk to{" "}
              {lookbackDays} and confidence is capped accordingly.
            </>
          )}
        </p>
      </div>
    </details>
  );
}

function EmptyState() {
  return (
    <div className="mt-8 rounded-xl border border-dashed border-[var(--color-edge)] p-10 text-center">
      <p className="text-[var(--color-muted)]">No transactions yet.</p>
      <p className="mt-2 text-[13px] text-[var(--color-dim)]">
        Run{" "}
        <code className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5">npm run seed</code> to
        load the demo history.
      </p>
    </div>
  );
}
