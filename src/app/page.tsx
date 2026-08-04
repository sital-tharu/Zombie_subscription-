import { GapQuestion } from "@/components/gap-question";
import { PlanPanel } from "@/components/plan-panel";
import { UploadScreenshot } from "@/components/upload-screenshot";
import { VerdictCard } from "@/components/verdict-card";
import { analyze, LOOKBACK_DAYS } from "@/lib/correlate";
import { inr, monthsLabel, shortDate } from "@/lib/format";
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

// Read at request time. The verdicts depend on today's date and on answers the
// user may have given seconds ago, so a build-time snapshot would be wrong.
export const dynamic = "force-dynamic";

export default async function Home() {
  const store = await getStore();
  const [transactions, answers, proposal] = await Promise.all([
    store.listTransactions(),
    store.listAnswers(),
    store.latestProposal(),
  ]);

  const result = analyze(transactions, undefined, { answers });
  const flagged = result.verdicts.filter((v) => v.verdict === "likely-unused");
  // Everything the plan panel needs about each service, resolved server-side.
  // The alternative is importing the merchant map into a client component,
  // which would ship all 21 entries and their patterns to the browser for the
  // sake of two strings.
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
    <main className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
      <header className="mb-10">
        <div className="flex items-center gap-2.5">
          <span className="size-2.5 rounded-full bg-[var(--color-zombie)]" />
          <span className="text-sm font-semibold tracking-[0.2em] text-[var(--color-muted)] uppercase">
            Zombie
          </span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">
          Subscriptions you pay for but don&apos;t use
        </h1>
        <p className="mt-2 max-w-2xl text-[var(--color-muted)]">
          Your bank can already list your recurring charges. This judges whether you
          still <em>use</em> them — and shows the transactions behind every verdict.
        </p>
        {hasGeminiKey() && (
          <div className="mt-5">
            <UploadScreenshot />
          </div>
        )}
      </header>

      {transactions.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <section className="mb-10 grid gap-4 sm:grid-cols-3">
            <Stat
              value={inr(result.totalWasted)}
              label="wasted to date"
              detail={
                flagged.length > 0
                  ? `across ${flagged.length} ${flagged.length === 1 ? "subscription" : "subscriptions"}`
                  : "nothing flagged yet"
              }
              accent
            />
            <Stat
              value={inr(result.annualSavings)}
              label="a year, if you cancel them"
              detail="12 × the monthly cost of every flagged subscription"
            />
            <Stat
              value={String(result.subscriptions.length)}
              label="recurring charges found"
              detail={`${result.needsInput.length} we can't judge without you`}
            />
          </section>

          {/* The two windows, side by side. They are different spans, and until
              this line existed the difference could only be explained out loud. */}
          <p className="-mt-6 mb-10 text-sm text-[var(--color-muted)]">
            <span className="text-[#e9edf5]">{result.transactionsAnalysed} transactions</span> over{" "}
            {monthsLabel(result.historySpanDays)}
            {result.historyStart && (
              <span className="text-[var(--color-dim)]">
                {" "}
                ({shortDate(result.historyStart)} – {shortDate(result.asOf)})
              </span>
            )}
            <span className="mx-2 text-[var(--color-dim)]">·</span>
            usage checked over the{" "}
            <span className="text-[#e9edf5]">last {result.lookbackDays} days</span>
          </p>

          <section className="mb-10">
            <SectionHeading
              title="Ranked by money wasted"
              subtitle="Open any card to see exactly why — every rupee traces to a transaction."
            />
            <HowDetectionWorks lookbackDays={result.lookbackDays} />
            <div className="space-y-3">
              {result.verdicts.map((verdict) => (
                <VerdictCard key={verdict.merchantKey} verdict={verdict} />
              ))}
            </div>
          </section>

          {result.needsInput.length > 0 && (
            <section className="mb-10">
              <SectionHeading
                title="We genuinely can't tell"
                subtitle="These leave no trace in your transactions when you use them. Rather than guess, we ask — and until you answer, they count for nothing."
              />
              <div className="space-y-3">
                {result.needsInput.map((verdict) => (
                  <GapQuestion key={verdict.merchantKey} verdict={verdict} />
                ))}
              </div>
            </section>
          )}

          <section className="mb-10">
            <SectionHeading
              title="Your plan"
              subtitle="A checklist, not an action. Nothing is cancelled on your behalf — ever."
            />
            <PlanPanel proposal={proposal} services={services} />
          </section>
        </>
      )}

      <footer className="mt-12 border-t border-[var(--color-edge)] pt-6 text-sm text-[var(--color-dim)]">
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

function Stat({
  value,
  label,
  detail,
  accent = false,
}: {
  value: string;
  label: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-5">
      <div
        className={`tnum text-3xl font-semibold ${accent ? "text-[var(--color-zombie)]" : ""}`}
      >
        {value}
      </div>
      <div className="mt-1 text-sm">{label}</div>
      <div className="mt-0.5 text-xs text-[var(--color-dim)]">{detail}</div>
    </div>
  );
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
    <details className="mb-4 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)]">
      <summary className="flex items-center gap-2 px-4 py-2.5 text-sm text-[var(--color-muted)]">
        <svg className="chev size-3.5 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        What counts as a subscription?
      </summary>
      <div className="space-y-3 border-t border-[var(--color-edge)] px-4 py-4 text-sm text-[var(--color-muted)]">
        <p>
          A charge becomes a subscription when all four hold: the same merchant, charges{" "}
          <span className="text-[#e9edf5]">{minGap}–{maxGap} days</span> apart, each within{" "}
          <span className="text-[#e9edf5]">±{Math.round(AMOUNT_TOLERANCE * 100)}%</span> of the one
          before it, and at least{" "}
          <span className="text-[#e9edf5]">{MIN_OCCURRENCES} of them</span> in an unbroken run.
        </p>
        <p>
          Two different time windows are involved, and mixing them up is the easiest way to get a
          wrong number:
        </p>
        <ul className="space-y-1.5 pl-4">
          <li className="list-disc">
            <span className="text-[#e9edf5]">Charge history is unbounded.</span> Chains are traced as
            far back as your data goes — there is no month limit anywhere in the system.
          </li>
          <li className="list-disc">
            <span className="text-[#e9edf5]">Usage is checked over {lookbackDays} days.</span> That
            decides the verdict. But the <em>score</em> is bounded by when you last used the service,
            however long ago that was — so a subscription last used 115 days ago counts only the
            charges billed since, not the whole chain.
          </li>
        </ul>
        <p className="text-[var(--color-dim)]">
          A gap longer than {maxGap} days, or a price jump beyond{" "}
          {Math.round(AMOUNT_TOLERANCE * 100)}%, ends the chain — only the current run counts.
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

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">{subtitle}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-edge)] p-10 text-center">
      <p className="text-[var(--color-muted)]">No transactions yet.</p>
      <p className="mt-2 text-sm text-[var(--color-dim)]">
        Run <code className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5">npm run seed</code> to
        load the demo history.
      </p>
    </div>
  );
}
