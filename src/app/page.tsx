import { VerdictCard } from "@/components/verdict-card";
import { analyze } from "@/lib/correlate";
import { inr } from "@/lib/format";
import { getStore, storeMode } from "@/lib/store";

// Read at request time. The verdicts depend on today's date and on answers the
// user may have given seconds ago, so a build-time snapshot would be wrong.
export const dynamic = "force-dynamic";

export default async function Home() {
  const store = await getStore();
  const [transactions, answers] = await Promise.all([
    store.listTransactions(),
    store.listAnswers(),
  ]);

  const result = analyze(transactions, undefined, { answers });
  const flagged = result.verdicts.filter((v) => v.verdict === "likely-unused");

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

          <section className="mb-10">
            <SectionHeading
              title="Ranked by money wasted"
              subtitle="Open any card to see exactly why — every rupee traces to a transaction."
            />
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
                  <div
                    key={verdict.merchantKey}
                    className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-4 sm:p-5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{verdict.merchant}</div>
                      <p className="mt-1 text-sm text-[var(--color-muted)]">{verdict.question}</p>
                    </div>
                    <div className="text-right text-sm">
                      <div className="tnum text-[var(--color-unsure)]">
                        {inr(verdict.potentialWaste)}
                      </div>
                      <div className="text-xs text-[var(--color-dim)]">riding on the answer</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <footer className="mt-12 border-t border-[var(--color-edge)] pt-6 text-sm text-[var(--color-dim)]">
        <p>
          Every verdict and every figure on this page is computed in TypeScript from your
          transaction history. AI reads screenshots and writes the plan; it never produces a
          number.
        </p>
        <p className="mt-2">
          Reading {transactions.length} transactions from the {storeMode()} store · analysed as of{" "}
          {result.asOf}
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
