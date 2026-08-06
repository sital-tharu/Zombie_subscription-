# Zombie

**The subscription agent that judges usage, not billing.**

Every bank app can already tell you what you're charged each month. None of them
can tell you whether you still *use* any of it. Zombie closes that gap: it
correlates each recurring charge against the transaction and email footprint a
service leaves when it's genuinely used, and reports the ones that have gone
quiet.

Built for the AI Agent Builder Series 2026 Grand Finale, FinTech problem
statement #1.

**Live:** https://zombie-chi.vercel.app

---

## The one design decision that matters

**Gemini never produces a number.**

- **Gemini does:** read screenshots and receipt emails, classify merchants it
  doesn't recognise, and write the prose of the final plan.
- **Code does:** recurring detection, usage inference, every verdict, and every
  rupee.

A `zombieScore` is the **sum of the actual charges billed after the last piece
of usage evidence**. Its unit is rupees and every rupee carries the transaction
id it came from, so the savings headline reconciles against the charge history
by construction rather than by trust. An LLM that invents a savings figure is
worse than useless in a money product — it looks exactly as trustworthy as a
real one.

The separation is enforced in four independent places, not merely intended:

1. An ESLint rule forbids the five engine files from importing Zod,
   firebase-admin, Gemini, React or Next (`eslint.config.mjs`). One stray
   import and `npm run test:logic` would start needing credentials.
2. The proposal response schema has **no numeric field** for a number to
   arrive in.
3. `foreignNumbers()` sweeps every generated sentence, and a figure that wasn't
   supplied discards the whole reply — not just the offending sentence.
4. The chat assistant computes a code-authored answer *before* Gemini is called,
   and ships it whenever the model's reply can't be trusted.

## The honest case

Plenty of services — Netflix, Spotify, ChatGPT, cloud storage — leave no
transaction footprint at all. **24 of the 32 mapped services are in this
category**, and the ratio got worse as the map grew: AI assistants and creative
tools are all pay-once-then-use-invisibly.

Zombie does not guess at those. They get `verdict: "unknown"`, a `zombieScore`
of **0**, and a direct question to the user. No evidence means no claim, and
unanswered unknowns contribute exactly zero to the headline totals. This is a
headline feature, not a fallback.

## What's in it

**Screenshot intake.** Drop a Google Pay screenshot on `/upload`; Gemini reads
it, Zod validates it, and the engine never sees anything unvalidated.

**Gmail sync.** Connect once and Zombie reads a single Gmail label, in both
directions: bills become transactions with real amounts (tagged `Source = mail`
on the dashboard), and order confirmations become usage evidence. The scope is
`gmail.readonly` because a bill's amount lives in the message *body* — a
header-only scope cannot read one. There is no label-scoped OAuth scope in
existence, so the label filter is a promise this code keeps, not one Google
enforces. Said plainly here because it is the widest permission the app asks for.

**The month navigator.** Page back to any earlier month and the entire engine
re-runs as of that month's end — so April shows the verdicts the agent would
genuinely have reached in April, not today's verdicts filtered. A subscription
used then and abandoned since correctly reads "used" in April. This works only
because verdicts are computed on every request and never stored.

**Cancellation ticks, with a guard.** Tick an item once you've actually
cancelled it and it leaves the monthly total. If a charge shows up for it
afterwards, the engine puts it back and stops claiming the saving — an agent
that keeps congratulating you for a cancellation that silently failed is worse
than one that never tracked it.

**A chat assistant** that can restate the dashboard but cannot out-run it. Every
figure is computed before Gemini is called; if a reply contains a number that
wasn't supplied, the whole reply is thrown away and a code-authored answer ships
instead.

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in GEMINI_API_KEY and OWNER_KEY
npm run test:logic           # 100 engine checks — needs no credentials at all
npm run seed                 # scripted demo history with planted zombies
npm run dev                  # localhost:3000
```

That's the whole setup. **Firestore is optional** — with no service account
configured the app writes to `./data/zombie.json` instead, so a clean clone runs
and the demo works before anyone opens the Firebase console. Gemini is optional
too: without a key, screenshot intake is hidden and the plan is generated
deterministically from the same figures. Gmail is optional; without it the
Connect control renders setup instructions instead.

## Configuration

Everything lives in `.env.local`, which is gitignored and **never deployed**.
Vercel keeps a completely separate environment-variable store — nothing syncs
between the two, which is the single most common cause of "works locally,
silently doesn't in production".

| Variable | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | for intake & prose | From [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Screenshot reading, merchant fallback classification, plan wording. Never a number. |
| `OWNER_KEY` | for any deployment | Single-owner passcode. Sent as the `x-owner-key` header on write routes, and rides along as the OAuth `state` parameter so the Gmail callback can prove it came from our own auth route. Unset ⇒ routes are open. |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | local only | Path to the service account JSON in `./secrets/`. **Cannot work on Vercel** — `secrets/` is gitignored and never deployed. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | on Vercel | The **entire** service account JSON collapsed to one line. The deployment's only workable option. |
| `GMAIL_CLIENT_ID` | for Layer 2b | OAuth client id. Public by design — it appears in every consent URL. |
| `GMAIL_CLIENT_SECRET` | for Layer 2b | From the same OAuth client. A real secret; never commit it. |
| `GMAIL_LABEL` | no | Only mail carrying this label is ever fetched. Defaults to `zombie`. |
| `GMAIL_MAX_RESULTS` | no | Ceiling on messages read per sync. Defaults to `50`. |
| `ZOMBIE_STORE` | no | `local` forces the JSON store even when Firebase credentials exist. How real financial data is kept off the public deployment. |
| `CHAT_DAILY_LIMIT` | no | Daily ceiling on chat questions. Defaults to `200`. A cost floor, **not** rate limiting — see below. |

`CHAT_DAILY_LIMIT` is one global counter, so a single caller can drain the day
and lock everyone else out. That is an acceptable failure for a single-owner
demo whose alternative is an unbounded bill; it would not be acceptable as a
security control, and calling it rate limiting would be the kind of claim that
unravels under one question.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on localhost:3000 |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run lint` | ESLint, including the engine purity boundary |
| `npm run test:logic` | 100 engine regression checks — pure functions, no creds |
| `npm run seed` | Seed date-relative demo history and print the verdicts |
| `npm run demo:reset` | Purge real data, re-seed, and fail loudly if any figure drifted |
| `npm run wipe:seed` | Remove demo data, leaving real transactions |
| `npm run wipe:real` | Remove real transactions, leaving demo data |
| `npm run ingest -- --dry-run` | Read every image in `samples/` without writing |
| `npm run probe:gemini` | Check the key authenticates, and measure latency |
| `npm run probe:extract` | Run a synthetic screenshot through the real intake path |

⚠️ **Every script calls its JS entry point directly** (`node
node_modules/next/dist/bin/next dev`) rather than using a `node_modules/.bin`
name. The project path contains `&`, which breaks npm's Windows `.cmd` shims.
Don't "tidy" these back to bin names.

## Architecture

Described in full in [`docs/architecture.md`](docs/architecture.md).

**Layer 1 — Recurring detection** · `src/lib/subscriptions.ts`
Same merchant, 25–35 day cadence, amount within ±10%, 3+ occurrences. Table
stakes — every bank app ships this. It exists here only because scoring needs
the full charge chain with per-charge traceability, which no off-the-shelf
tracker exposes. A chain that hasn't billed in 40 days is treated as already
ended, so it can't contribute a year of imaginary savings.

**Layer 2 — Usage correlation** · `src/lib/correlate.ts`, `src/lib/merchant-map.ts`
The differentiator. Subscription-to-usage merchant mapping over a 90-day
lookback, across 32 Indian services. Matching is by **contiguous token
sequence**, not substring — `ola` is inside "Choc-ola-te Room", and `in` is
inside almost everything.

- **2b — email evidence** · `src/lib/gmail.ts`
  Order confirmations and dispatch notices count as use, with the same
  precedence rule that protects Layer 2. This catches spending the app never
  sees — a Swiggy order paid by card — which would otherwise look like silence,
  and silence is what gets flagged. A correctness feature before a coverage one.
- **2c — the evidence gap handler**
  24 of the 32 services leave no footprint. Those are asked about, never guessed
  at. A *recognised* service we can't observe earns confidence `low`; an
  entirely unmapped merchant earns `none`. Different admissions, kept apart.

**Layer 3 — Zombie score and proposal** · `src/lib/correlate.ts`, `src/lib/proposal.ts`
Rupees traceable to transaction ids, ranked by score descending, turned into
language by Gemini but never into numbers.

### Two ranges that must never be conflated

The 90-day window and the score deliberately read different spans:

- the **window** asks *"any usage in the last 90 days?"* and decides the
  **verdict**;
- **last usage** is sought across **all** history and bounds the **score**.

Zomato Gold is the case that separates them: the last order is ~115 days ago,
outside the window, so the verdict is `likely-unused` — but the score must be
bounded by that order, not by the window. Compute last usage from the
window-filtered list and it comes back null, the never-used branch fires, and
the demo shows roughly twice the real figure with no error and a perfectly
plausible evidence chain.

### The trap worth knowing about

An "Amazon Prime" charge matches the usage pattern `amazon`. Without precedence,
every subscription cites its own monthly bill as proof it is being used, every
verdict returns "used", and the app reports zero zombies — silently, with no
error and a perfectly reasonable-looking screen. It fails completely and it
fails quietly.

The defence has two independent halves:

- `subscriptionPatterns` are checked across the **whole map** before any usage
  pattern is consulted, and they always win;
- a subscription's own charges are additionally excluded by transaction id.

The same trap exists in the email domain — a renewal notice must never prove
that the subscription it bills for is in use — so `isEmailUsageEvidence()`
mirrors `isUsageEvidence()` step for step, with a global billing-subject check
in the brace position. Both are pinned by tests, and those tests also prove the
underlying collision is real, so the check can't quietly become vacuous.

## Verifying it works

`npm run test:logic` is the gate. It imports only the pure engine files and runs
with no Firestore, no Gemini and no network. Beyond the unit checks it asserts
the entire demo dataset:

```
Amazon Prime      likely-unused  high    ₹2,093   7 charges, zero Amazon orders
Zomato Gold       likely-unused  high    ₹800     4 of 8 charges; orders stopped 115 days ago
Netflix           unknown        low     ₹0       no footprint — we ask instead
KUKU FM PREMIUM   unknown        none    ₹0       unmapped merchant — we ask instead
Swiggy One        used           high    ₹0       6 orders in the last 90 days

Total wasted ₹2,893 · Annual savings ₹5,988 · Monthly run rate ₹1,746
```

Those figures are asserted at four anchor dates through March 2027, because
every seeded date is generated relative to the run date — the demo can't go
stale.

Before recording anything, run `npm run demo:reset`. It clears answers,
cancellations, synced mail, proposals and any real transactions, re-seeds, and
**exits non-zero if the figures drift from `EXPECTED_SEED_OUTCOME`**. A demo
accumulates state that silently moves every headline figure.

## API

The dashboard's own controls use server actions, so no secret is ever shipped to
the browser. These routes exist for programmatic use and are gated by the
`x-owner-key` header when `OWNER_KEY` is set.

| Route | Purpose |
|---|---|
| `POST /api/extract` | multipart field `screenshot` → extracted transactions |
| `POST /api/verdicts/{merchantKey}/answer` | `{ "used": boolean }` — outranks every inference, in both directions |
| `POST /api/proposal` | Generate a plan · `PATCH` `{ id, status }` to accept or reject · `GET` for the latest |
| `GET /api/gmail/auth` · `GET /api/gmail/callback` | OAuth handshake. `auth` is header-gated; `callback` verifies the owner key echoed back in `state`, because Google cannot send a header. |
| `POST /api/gmail/sync` | Read the labelled mail; returns extracted bills and usage evidence |

## Live deployment

**https://zombie-chi.vercel.app**

Publicly readable, backed by Firestore, seeded demo data only. Redeploy with:

```bash
npx vercel deploy --prod
```

Use a stable alias, not the URL `vercel deploy` prints — that one is unique per
deployment (`zombie-f838vpwf8-…`) and goes stale the moment you deploy again.

**Two stable aliases serve the same production deployment**:
`zombie-chi.vercel.app` and `zombie-sital-tharus-projects.vercel.app`. Harmless
for reading, and it matters for Gmail: the OAuth redirect URI is derived from
the host the browser is on, so connecting from an alias that isn't registered in
the Google Cloud console fails with `redirect_uri_mismatch`. **Connect from
`zombie-chi.vercel.app`**, which is the registered one.

⚠️ **`zombie.vercel.app` is a different project** belonging to someone else. It
resolves and returns 200, so it is an easy and very costly mistake to link.

### Privacy: the deployed database holds synthetic data only

The dashboard is public and has **no login of its own** — only the write routes
check `x-owner-key`. So real transactions must never reach the deployed
database, and the two-track split is enforced by tooling rather than by memory:

```bash
ZOMBIE_STORE=local npm run ingest   # dogfood locally; real data stays on disk
npm run wipe:real                   # purge real rows before exposing anything
```

`ZOMBIE_STORE=local` forces the JSON store even when Firebase credentials are
present. The alternative — moving the service account file around to change
behaviour — is exactly the kind of manual step that gets forgotten with real
financial data on the wrong side of it.

Never commit `.env.local`, `secrets/` (the Firebase service account) or
`samples/` (personal financial screenshots). All three are gitignored.

## Deploying from scratch

The repo builds as-is. The work is environment variables, plus some Google Cloud
setup if you want Gmail sync on the deployment too.

### 1. Vercel

[vercel.com/new](https://vercel.com/new) → import the repo, or `npx vercel link`.
Framework detection needs no changes.

Set these under **Settings → Environment Variables**, applied to Production,
Preview *and* Development:

| Variable | Value |
|---|---|
| `OWNER_KEY` | Your passcode |
| `GEMINI_API_KEY` | From aistudio.google.com/apikey |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | The **entire** service account JSON, one line |
| `GMAIL_CLIENT_ID` | Optional; see step 2 |
| `GMAIL_CLIENT_SECRET` | Optional; see step 2 |
| `GMAIL_LABEL` | `zombie`, or whichever label you actually tag mail with |

**Do not set `FIREBASE_SERVICE_ACCOUNT_PATH` on Vercel.** `secrets/` is
gitignored and never deployed, so the file cannot exist there — which is why the
store accepts the credentials inline as an alternative.

**Vercel binds environment variables into a deployment when that deployment is
built.** Adding a variable to a deployment that already exists changes nothing
until you redeploy. This catches everyone once.

### 2. Gmail OAuth (optional — Layer 2b)

In a Google Cloud project: **APIs & Services → Credentials → Create OAuth client
ID → Web application**. Then, in that same project:

- enable the **Gmail API**;
- configure the **OAuth consent screen** and add yourself as a **test user**;
- add both callbacks under **Authorised redirect URIs**:

```
http://localhost:3000/api/gmail/callback
https://<your-deployment>/api/gmail/callback
```

Leave **Authorised JavaScript origins** empty — this is a server-side flow and
doesn't use it.

**One client, both URIs, and the same id and secret in `.env.local` *and*
Vercel.** The project matters as much as the client: the Gmail API enablement,
consent screen and test-user list all live at the project level, and an OAuth
client from a different project drags all of that with it. Client ids carry
their project number as a prefix (`780810675511-…`), so two ids with different
prefixes are two different projects.

Then **redeploy**, and connect from the alias whose callback you registered.

⚠️ **While the consent screen is in Testing, refresh tokens expire after seven
days.** `gmail.readonly` is a restricted scope, so an unverified app issues
short-lived grants: sync starts returning 403 about a week after it last worked,
and the cure is Disconnect → Connect, not a code change. Reconnect shortly
before anything that matters.

## Troubleshooting

**"Connect Gmail" does nothing on the deployment, but works on localhost.**
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` aren't set in Vercel. `.env.local` is
never deployed and nothing syncs it. With the pair missing,
`hasGmailCredentials()` is false and the header renders a `<details>` panel whose
`<summary>` is styled identically to the real button — so clicking expands setup
text and never calls Google. No error, no console warning, no network request,
because nothing was attempted. Add the variables, then **redeploy**.

**`Error 400: redirect_uri_mismatch` at the consent screen.** The redirect URI is
built from the incoming `Host` header, so it's whatever alias the browser is on.
Register that exact origin, or connect from the one you registered. Changes can
take a few minutes to propagate — if it fails immediately after saving, wait
five minutes and retry before changing anything else.

**Gmail sync 403s after working for a week.** Testing-mode refresh token expiry.
Disconnect → Connect.

**"No Firebase credentials in a Vercel deployment".** Deliberate: the app throws
a named error rather than falling back to the local JSON store. That fallback
writes to `./data`, a serverless filesystem is read-only, and the result would be
a dashboard rendering an empty state while silently discarding every write —
indistinguishable from an empty account. Failing loudly is correct here.

**Everything 500s with a quota error.** Firestore's free tier allows 50,000
document reads a day and one dashboard render costs roughly 110. A dev server
pointed at the deployment's database drains it in an afternoon, and the first
symptom is the *public site* failing while nothing locally looks wrong. Every
process prints which store it opened on startup — check that line. Use
`ZOMBIE_STORE=local` for local work.

**Gemini extraction hangs or 404s.** The model is pinned to
`gemini-3.1-flash-lite` in `src/lib/gemini.ts` and this is not up for
relitigation: `gemini-2.5-flash` 404s for newly issued API keys, and the
alternatives hang on the free tier. Run `npm run probe:gemini` to measure
latency before changing anything else.

## Project layout

```
src/lib/
  types.ts  dates.ts  merchant-map.ts  subscriptions.ts  correlate.ts
                  ^ the five pure engine files. No Zod, no Firestore, no
                    Gemini, no React — enforced by ESLint, not by convention.
  schemas.ts      Zod — validates every LLM output before the engine sees it
  store.ts        Firestore / local-JSON adapters behind one interface
  gmail*.ts       OAuth and label-filtered intake
  chat*.ts        the assistant, and its grounding guard
  proposal.ts     plan generation + foreignNumbers()
src/app/          App Router pages, server actions, API routes
src/components/   dashboard UI
scripts/          seed, wipe, demo:reset, probes, and test-logic.ts
docs/             PRD and architecture
```

## Stack

Next.js 16 App Router · Antgravity · TypeScript · Tailwind v4 · React 19 · Zod 4 ·
`@google/genai` (pinned to `gemini-3.1-flash-lite`) · `firebase-admin`
(server-side only, no client SDK, no security rules) · deployed on Vercel.

## Status

P0 complete: engine, tests, seed, storage, dashboard, evidence chains, gap
handler, screenshot intake and grounded proposals.

P1 complete: Gmail OAuth, email intake and email usage evidence (Layer 2b), live
on the deployment.

Shipped beyond the original plan: the month navigator, cancellation tracking and
the chat assistant. See [`docs/PRD.md`](docs/PRD.md) for the product spec and
[`docs/architecture.md`](docs/architecture.md) for how the pieces fit.

Deliberately out of scope: autonomous cancellation (the agent proposes, the
human disposes — a permanent product principle), multi-user accounts, bank and
app-store API integration, and device telemetry.
