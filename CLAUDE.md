@AGENTS.md

# Zombie — the subscription agent that judges usage, not billing

Finds subscriptions you pay for but no longer **use**. Solo build for the
**AI Agent Builder Series 2026 Grand Finale**, FinTech problem statement #1
("users continue paying for unused subscriptions without realizing it").
Final submission **8 Aug 2026, 3:30 PM IST**. Optimize for a strong, clear
demo over production robustness.

**The thesis:** recurring-charge detection is solved — every bank app does it.
Usage detection is not. That gap is the product. Do not let work drift back
into building a better subscription tracker.

## Commands

- `npm run dev` — dev server (localhost:3000)
- `npm run build` / `npm run start` — production build/serve
- `npm run lint` — ESLint
- `npm run test:logic` — engine regression checks (pure functions, no creds)
- `npm run seed` — seed scripted demo history with planted zombies

## Architecture — three layers

**Layer 1 — Recurring detection** (`src/lib/subscriptions.ts`). Same merchant,
25–35 day cadence, amount within ±10%, 3+ occurrences. Lifted from Rupee Radar
and extended to return the full charge chain (`firstDate`, `totalPaid`,
`chargeIds`) because scoring needs per-charge traceability. **Table stakes, not
the product.**

**Layer 2 — Usage correlation** (`src/lib/correlate.ts`, `src/lib/merchant-map.ts`).
The differentiator. Many subscriptions leave a transaction footprint when
genuinely used: Amazon Prime → Amazon purchases, Swiggy One → Swiggy orders.
Zero correlated activity across the 90-day lookback = likely unused.

⚠️ **The self-validation trap.** An "Amazon Prime" charge matches the usage
pattern `amazon`. Without precedence, every subscription cites its own bill as
proof of use and the app reports zero zombies — silently, with no error.
`isUsageEvidence()` checks `subscriptionPatterns` FIRST and they always win;
subscription charges are also excluded by transaction id. This is pinned by
tests. **Never weaken it.**

**Layer 2c — Evidence Gap Handler.** Services with no transaction footprint
(Netflix, Spotify, cloud storage) and unrecognised merchants get
`verdict: "unknown"` and a question for the user — never a guess.
`zombieScore` is **0** for these: no evidence means no claim. This is a feature
and a demo beat, not a fallback.

**Layer 3 — Zombie score & proposal.** `zombieScore` = the **sum of actual
subscription charges billed after the last usage evidence** (all charges if
usage was never seen). Its unit is rupees, and every rupee traces to a
transaction id, so savings totals reconcile against history by construction.
Note this refines the PRD's `months idle × monthly cost` — same quantity,
auditable instead of approximated. Gemini turns finished findings into
language; it never produces a number.

## Non-negotiable: the deterministic / AI split

- **Gemini does:** multimodal intake (screenshots, receipt emails), the
  unmapped-merchant fallback classifier, and plan prose.
- **Code does:** recurring detection, usage inference, every verdict, every
  currency figure.

An LLM that invents a savings number is worse than useless in a money product.
If a task would put an LLM in the path of a number, stop and flag it.

## Stack

- **Next.js 16 App Router + TypeScript + Tailwind v4**, `src/` dir, `@/*` alias.
- **Gemini** via `@google/genai`, pinned to `gemini-3.1-flash-lite`.
  `gemini-2.5-flash` 404s for new API keys and alternatives hang on the free
  tier. Hard-won — do not relitigate the pin. If extraction hangs or 404s,
  probe model latency before changing anything else.
- **Firestore** via `firebase-admin`, **server-side only** (no client SDK, no
  security rules). Base64 receipt images in a separate collection — a
  deliberate demo-grade choice avoiding the Blaze plan.
- **Zod** validates all LLM output before it reaches deterministic logic.
- **Auth:** single-owner passcode (`x-owner-key` header). Multi-user is a
  stated non-goal.
- Deployed on **Vercel**.

## Engine contract

`analyze(transactions, asOf?)` → `{ subscriptions, verdicts, totalWasted,
annualSavings, needsInput }`. Verdicts are ranked by `zombieScore` descending.
`asOf` is injectable so tests and demos are deterministic — keep it that way.

The engine takes `TransactionLike { id, merchant, date, total }` — structural,
no Zod or Firestore imports. Keep Layers 1–3 pure and framework-free so
`npm run test:logic` needs no credentials.

## Important context

- **npm scripts must call JS entry points via `node node_modules/...` directly**
  (e.g. `node node_modules/next/dist/bin/next dev`). The local project path
  contains `&`, which breaks npm's Windows `.cmd` shims — never rely on
  `node_modules/.bin` names in package.json scripts.
- Test data is **Google Pay transaction screenshots**, not paper receipts:
  merchant = UPI payee name, line items usually absent, amounts in ₹.
- **Two-track data:** real GPay/Gmail history for dogfooding; scripted
  date-relative synthetic history for demos, so the dataset never goes stale.
  The seed must plant zombies at HIGH, MEDIUM and unknown confidence — the
  demo arc is encoded in the fixtures.
- **Never commit:** `.env.local`, `secrets/` (Firebase service account JSON),
  `samples/` (personal financial screenshots). All gitignored.
- **The verdict engine is the product.** A wrong number on stage is fatal.
  Any change to Layer 1–3 logic ships with a test in `scripts/test-logic.ts`.

## Scope discipline

Explicitly **out**: multi-user accounts, autonomous cancellation, bank/app-store
API integration, device telemetry. These are stated non-goals in the PRD — do
not build them.

**Shipped, having previously been non-goals.** Both were reversed deliberately,
and both were made to obey the rules above rather than being granted exceptions:

- **Gmail intake + Layer 2b** (`gmail.readonly`, label-filtered). Bills become
  transactions through the *same* Zod schema as a screenshot; order
  confirmations become usage evidence through `isEmailUsageEvidence`, which
  mirrors `isUsageEvidence` step for step because the self-validation trap
  exists in the email domain too — a renewal notice must never prove that the
  subscription it bills for is in use.
- **The chat assistant** (`src/lib/chat.ts`). The one place a model talks to the
  user about money, so it is the **fourth** enforcement of "Gemini never
  produces a number": the engine computes every figure, Gemini is handed them
  and asked only for sentences, and `foreignNumbers` discards the entire reply
  if a single unsupplied digit appears in it. A code-authored answer is computed
  *before* the model is called and ships whenever the reply cannot be trusted.
  Never let this become a chatbot that does arithmetic.

## Environment (.env.local)

```
GEMINI_API_KEY=            # aistudio.google.com/apikey
FIREBASE_SERVICE_ACCOUNT_PATH=./secrets/serviceAccount.json
OWNER_KEY=                 # single-owner passcode; also the OAuth `state`
GMAIL_CLIENT_ID=           # optional; Layer 2b. Without it the control shows setup steps
GMAIL_CLIENT_SECRET=
GMAIL_LABEL=zombie         # only mail carrying this label is ever fetched
CHAT_DAILY_LIMIT=200       # cost floor on the assistant, not rate limiting
```

`npm run demo:reset` clears answers, cancellations, synced mail, proposals and
any real transactions, re-seeds, and **exits non-zero if the figures drift from
`EXPECTED_SEED_OUTCOME`**. Run it before recording anything: a demo accumulates
state that silently moves every headline figure.

See `PLAN.md` for the build sequence, data contracts and demo script.
See `docs/PRD.md` and `docs/architecture.md` for the submitted specs.
