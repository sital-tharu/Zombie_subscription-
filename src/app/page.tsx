import Link from "next/link";
import { Logo } from "@/components/logo";
import { PlanPanel } from "@/components/plan-panel";
import { SourceBadge, VerdictCard } from "@/components/verdict-card";
import { analyze, LOOKBACK_DAYS } from "@/lib/correlate";
import { round2, todayIso } from "@/lib/dates";
import {
  addMonths,
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
  const [transactions, answers, cancellations, proposal] = await Promise.all([
    store.listTransactions(),
    store.listAnswers(),
    store.listCancellations(),
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
  const result = analyze(transactions, asOf, { answers, cancellations });

  /*
   * The plan is about what to do NOW, so it is always built from a run as of
   * today -- even while the page is showing an older month.
   *
   * Without this the Done ticks silently do nothing on any past month. Ticking
   * writes a cancellation dated today; the engine then correctly rules it out
   * of a 31-July view, because on 31 July it had not happened; so the checkbox
   * never ticks and clicking again just rewrites the same date. The engine is
   * right and the time machine has to keep that filter -- it is the UI that was
   * wrong to read an action list through a historical lens.
   *
   * On the current month this is the very same object, so there is no second
   * pass in the common case.
   */
  const planResult = isCurrentMonth
    ? result
    : analyze(transactions, today, { answers, cancellations });

  /*
   * Flagged AND still being paid for. A cancelled subscription keeps its
   * likely-unused verdict -- that judgement was correct and its wasted figure
   * still stands -- but it must not be counted alongside "still on the table",
   * which is money you could yet save. Counting it there would print
   * "Rs 2,400 still on the table, across 2 subscriptions" when only one of them
   * is still costing anything.
   */
  const flagged = result.verdicts.filter(
    (v) => v.verdict === "likely-unused" && v.status === "active",
  );
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
   * Three groups, and the tile below counts only the first.
   *
   * `status === "ended"` already covers both ways of not paying any more -- a
   * cancellation the user declared, and a chain that simply went quiet -- so
   * the tile and the engine cannot drift apart about what "active" means.
   */
  const activeVerdicts = result.verdicts.filter((v) => v.status === "active");
  const finishedVerdicts = result.verdicts.filter((v) => v.status === "ended");
  const cancelledCount = finishedVerdicts.filter((v) => v.cancellation).length;
  const stoppedCount = finishedVerdicts.length - cancelledCount;

  // What the user has actually saved by cancelling: only declarations that were
  // not contradicted by a later charge. `status === "ended"` is exactly that
  // test, so a still-billing subscription contributes nothing here.
  const savedAnnual = round2(
    12 *
      finishedVerdicts
        .filter((v) => v.cancellation)
        .reduce((sum, v) => sum + v.monthlyAmount, 0),
  );

  // Every transaction in the month, chained or not. The only place in the
  // product where a raw row is visible, and the answer to "did my upload work".
  const chainedIds = new Set(
    result.verdicts.flatMap((v) => v.evidence.charges.map((c) => c.id)),
  );
  const monthTransactions = transactions
    .filter((txn) => txn.date.startsWith(selectedMonth))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id < b.id ? 1 : -1));

  // One-off spending: everything billed this month that is NOT part of a chain.
  // Subscription charges are excluded here because the run rate already counts
  // them, and adding both would bill the user twice on screen.
  const paymentsMade = round2(
    monthTransactions
      .filter((txn) => !chainedIds.has(txn.id))
      .reduce((sum, txn) => sum + txn.total, 0),
  );
  const totalSpend = round2(result.monthlyRunRate + paymentsMade);
  const monthTotal = round2(monthTransactions.reduce((sum, txn) => sum + txn.total, 0));

  // Ten visible, the rest a click away. A month of real GPay history is
  // hundreds of rows, and an unbounded table would push the plan off the page.
  const visibleTransactions = monthTransactions.slice(0, 10);
  const hiddenTransactions = monthTransactions.slice(10);

  // So a subscription charge in the list still carries its verdict. Without it
  // the widest table on the page would be the one place a charge appears with
  // no judgement attached, which is the drift CLAUDE.md warns about.
  const verdictByTxn = new Map(
    result.verdicts.flatMap((v) => v.evidence.charges.map((c) => [c.id, v] as const)),
  );

  // What is still to come this month. The seed's charges all land in the back
  // half of a month, so on the 4th the current month is legitimately empty --
  // and "nothing yet, here is what is coming" is the true answer, not a bug.
  const upcoming = result.verdicts
    .filter((v) => monthKey(v.nextCharge) === selectedMonth && v.nextCharge > today)
    .sort((a, b) => (a.nextCharge < b.nextCharge ? -1 : 1));

  const prevMonth = addMonths(selectedMonth, -1);
  const nextMonth = addMonths(selectedMonth, 1);
  const hasPrev = prevMonth >= earliestMonth;

  // From planResult, not result: these carry the tick state, and it must be
  // today's, not the selected month's.
  const services = Object.fromEntries(
    planResult.verdicts.map((v) => [
      v.merchantKey,
      {
        name: v.merchant,
        monthlyAmount: v.monthlyAmount,
        // Carried so each plan item can show its own money without the panel
        // re-deriving anything. Both come straight off the engine's verdict.
        wasted: v.zombieScore,
        atStake: v.potentialWaste,
        cancelledAt: v.cancellation?.cancelledAt,
        // Non-empty means the cancellation did not take -- the panel says so
        // rather than claiming a saving that is still leaving the account.
        stillBilling: (v.cancellation?.chargedSince.length ?? 0) > 0,
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
            {hasGeminiKey() && (
              <Link
                href="/upload"
                className="rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-muted)]"
              >
                + Add a screenshot
              </Link>
            )}
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
                Total spend · {isCurrentMonth ? "this month" : monthLabel(selectedMonth)}
              </p>
              <p className="tnum mt-1 font-mono text-3xl font-medium tracking-tight">
                {inr(totalSpend)}
              </p>
              {/*
                One of these is a commitment and the other is an actual, so both
                say which. "Subscriptions" is the run rate -- what the month
                costs you whether or not the charge has landed yet -- because
                every seeded charge falls late in the month and a billed-so-far
                figure reads zero on the 5th.
              */}
              <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                <span className="tnum text-[var(--color-fg)]">
                  {inr(result.monthlyRunRate)}
                </span>{" "}
                subscriptions due
                <span className="mx-1.5 text-[var(--color-dim)]">·</span>
                <span className="tnum text-[var(--color-fg)]">{inr(paymentsMade)}</span> daily
                expenses
              </p>
            </div>
            <div className="flex flex-col justify-center rounded-xl bg-[var(--color-panel)] p-4">
              <p className="text-[13px] text-[var(--color-muted)]">Recurring</p>
              <p className="mt-1 font-mono text-3xl font-medium tracking-tight">
                <span className="tnum">{activeVerdicts.length}</span>
                <span className="ml-2 text-[13px] font-normal text-[var(--color-muted)]">
                  {activeVerdicts.length === 1 ? "subscription" : "subscriptions"}
                </span>
              </p>
              <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                {[
                  cancelledCount > 0 && `${cancelledCount} cancelled`,
                  stoppedCount > 0 && `${stoppedCount} stopped`,
                  result.needsInput.length > 0 &&
                    `${result.needsInput.length} we can't judge`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "all judged"}
              </p>
            </div>
          </div>

          {/* The figure that makes this different from a bank app. It lost its
              place in the tile row to the spend breakdown, but not its
              prominence -- full width, and still above everything it explains. */}
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 rounded-xl bg-[var(--color-panel)] p-4">
            <div className="flex items-baseline gap-3">
              <p className="text-[13px] text-[var(--color-muted)]">
                Wasted to date{isCurrentMonth ? "" : ` · as of ${shortDate(asOf)}`}
              </p>
              <p className="tnum font-mono text-2xl font-medium tracking-tight text-[var(--color-zombie)]">
                {inr(result.totalWasted)}
              </p>
            </div>
            <p className="text-xs text-[var(--color-muted)]">
              {/* Saved sits next to the waste it cancels out, so the before and
                  after read as one sentence rather than two tiles. */}
              {savedAnnual > 0 && (
                <>
                  <span className="tnum font-medium text-[var(--color-alive)]">
                    {inr(savedAnnual)}
                  </span>{" "}
                  a year saved
                  <span className="mx-1.5 text-[var(--color-dim)]">·</span>
                </>
              )}
              {flagged.length > 0 ? (
                <>
                  <span className="tnum text-[var(--color-fg)]">
                    {inr(result.annualSavings)}
                  </span>{" "}
                  still on the table, across {flagged.length}{" "}
                  {flagged.length === 1 ? "subscription" : "subscriptions"}
                </>
              ) : savedAnnual > 0 ? (
                "nothing left on the table"
              ) : (
                "nothing flagged yet"
              )}
            </p>
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
              {activeVerdicts.map((verdict) => (
                <li key={verdict.merchantKey}>
                  <VerdictCard verdict={verdict} sources={sourcesFor(verdict)} />
                </li>
              ))}
            </ul>

            {/* Everything you have stopped paying for, out of the main list so
                it agrees with the Recurring count, but never deleted -- the
                money these already cost is still true and still traceable. */}
            {finishedVerdicts.length > 0 && (
              <details className="mt-2 overflow-hidden rounded-lg bg-[var(--color-panel)]">
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
                  {cancelledCount > 0 && stoppedCount > 0
                    ? `Cancelled and stopped (${finishedVerdicts.length})`
                    : cancelledCount > 0
                      ? `Cancelled (${cancelledCount})`
                      : `Stopped billing (${stoppedCount})`}
                  <span className="text-[var(--color-dim)]">
                    — no longer counted in your monthly total
                  </span>
                </summary>
                <ul className="flex flex-col gap-2 border-t border-[var(--color-edge)] p-2">
                  {finishedVerdicts.map((verdict) => (
                    <li key={verdict.merchantKey}>
                      <VerdictCard verdict={verdict} sources={sourcesFor(verdict)} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          {/*
            All transactions, chained or not.

            This replaced a subscription-only charges table. That table was
            built from detected chains, which meant the app silently swallowed
            uploads: a one-off recharge was parsed, validated and stored, then
            appeared nowhere, and a user could not tell a misread screenshot
            from a payment that simply is not a subscription. Nothing is lost by
            widening it -- subscription charges still appear, tagged with their
            verdict, and each one's full ledger is still inside its own card.
          */}
          <section className="mt-8">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] text-[var(--color-muted)]">
                All transactions in {monthLabel(selectedMonth)}
              </h2>
              {monthTransactions.length > 0 && (
                <span className="tnum text-xs text-[var(--color-dim)]">
                  {monthTransactions.length}{" "}
                  {monthTransactions.length === 1 ? "payment" : "payments"} · {inr(monthTotal)}
                </span>
              )}
            </div>

            {monthTransactions.length > 0 ? (
              <>
                <div className="mt-3 overflow-x-auto rounded-lg border border-[var(--color-edge)]">
                  <table className="w-full min-w-[460px] text-[13px]">
                    <thead>
                      <tr className="bg-[var(--color-panel)] text-left text-xs text-[var(--color-muted)]">
                        <th className="px-3.5 py-2 font-medium">Date</th>
                        <th className="px-3.5 py-2 font-medium">Merchant</th>
                        <th className="px-3.5 py-2 font-medium">Source</th>
                        <th className="px-3.5 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTransactions.map((txn) => (
                        <TransactionRow
                          key={txn.id}
                          txn={txn}
                          verdict={verdictByTxn.get(txn.id)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {hiddenTransactions.length > 0 && (
                  <details className="mt-2 overflow-hidden rounded-lg border border-[var(--color-edge)]">
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
                      Show {hiddenTransactions.length} more
                    </summary>
                    <div className="overflow-x-auto border-t border-[var(--color-edge)]">
                      <table className="w-full min-w-[460px] text-[13px]">
                        <tbody>
                          {hiddenTransactions.map((txn) => (
                            <TransactionRow
                              key={txn.id}
                              txn={txn}
                              verdict={verdictByTxn.get(txn.id)}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </>
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
          </section>

          {/* Your plan */}
          <section className="mt-8">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] text-[var(--color-muted)]">
                Your plan
                {/* Said out loud, because everything above this point on the
                    page is showing the selected month and this section is not. */}
                {!isCurrentMonth && (
                  <span className="ml-2 text-[var(--color-dim)]">· always about today</span>
                )}
              </h2>
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

/**
 * One row of the transactions table, shared by the visible ten and the rest.
 *
 * A charge that belongs to a subscription is tagged with that subscription's
 * verdict glyph, so the widest table on the page is never a place where money
 * appears without a judgement attached.
 */
function TransactionRow({
  txn,
  verdict,
}: {
  txn: StoredTransaction;
  verdict: UsageVerdict | undefined;
}) {
  return (
    <tr className="border-t border-[var(--color-edge)]">
      <td className="px-3.5 py-2 whitespace-nowrap text-[var(--color-muted)]">
        {shortDate(txn.date)}
      </td>
      <td className="px-3.5 py-2">
        {verdict && (
          <span aria-hidden="true" className={`mr-1.5 ${verdictTextClass(verdict.verdict)}`}>
            {verdictGlyph(verdict.verdict)}
          </span>
        )}
        {txn.merchant}
        {verdict && (
          <span className="ml-2 text-xs text-[var(--color-dim)]">subscription</span>
        )}
      </td>
      <td className="px-3.5 py-2">
        <SourceBadge label={sourceLabel(txn.source, txn.seeded)} />
      </td>
      <td className="tnum px-3.5 py-2 text-right font-mono">{inr(txn.total)}</td>
    </tr>
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
