# Zombie

**The subscription agent that judges usage, not billing.**

Every bank app can already tell you what you're charged each month. None of
them can tell you whether you still *use* any of it. Zombie closes that gap: it
correlates each recurring charge against the transaction footprint the service
leaves when it's genuinely used, and reports the ones that have gone quiet.

Built for the AI Agent Builder Series 2026 Grand Finale, FinTech problem
statement #1.

---

## The one design decision that matters

**Gemini never produces a number.**

- **Gemini does:** read screenshots and receipt emails, and write the prose of
  the final plan.
- **Code does:** recurring detection, usage inference, every verdict, and every
  rupee.

A `zombieScore` is the **sum of the actual charges billed after the last piece
of usage evidence**. Its unit is rupees and every rupee carries the transaction
id it came from, so the savings headline reconciles against the charge history
by construction rather than by trust. An LLM that invents a savings figure is
worse than useless in a money product — it looks exactly as trustworthy as a
real one.

The separation is enforced, not merely intended: an ESLint rule forbids the
engine from importing Zod, firebase-admin, Gemini, React or Next; the proposal
response schema has **no numeric field for a number to arrive in**; and any
generated sentence containing a figure that wasn't supplied is discarded whole.

## The honest case

Plenty of services — Netflix, Spotify, cloud storage — leave no transaction
footprint at all. Zombie does not guess at those. They get
`verdict: "unknown"`, a `zombieScore` of **0**, and a direct question to the
user. No evidence means no claim; unanswered unknowns contribute exactly zero
to the headline totals.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in GEMINI_API_KEY and OWNER_KEY
npm run test:logic           # 58 engine checks — needs no credentials at all
npm run seed                 # scripted demo history with planted zombies
npm run dev                  # localhost:3000
```

That's the whole setup. **Firestore is optional** — with no service account
configured the app writes to `./data/zombie.json` instead, so a clean clone runs
and the demo works before anyone opens the Firebase console. Gemini is optional
too: without a key, screenshot intake is hidden and the plan is generated
deterministically from the same figures.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on localhost:3000 |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run lint` | ESLint, including the engine purity boundary |
| `npm run test:logic` | 58 engine regression checks — pure functions, no creds |
| `npm run seed` | Seed date-relative demo history and print the verdicts |
| `npm run probe:gemini` | Check the key authenticates, and measure latency |
| `npm run probe:extract` | Run a synthetic screenshot through the real intake path |

## Architecture

Three layers, described in full in [`docs/architecture.md`](docs/architecture.md):

1. **Recurring detection** — same merchant, 25–35 day cadence, amount within
   ±10%, 3+ occurrences. Table stakes.
2. **Usage correlation** — subscription-to-usage merchant mapping over a 90-day
   lookback, across 21 Indian services. The differentiator.
3. **Zombie score and proposal** — rupees traceable to transaction ids, ranked,
   turned into language by Gemini but never into numbers.

### The trap worth knowing about

An "Amazon Prime" charge matches the usage pattern `amazon`. Without precedence,
every subscription cites its own monthly bill as proof it is being used, every
verdict returns "used", and the app reports zero zombies — silently, with no
error and a perfectly reasonable-looking screen.

Subscription patterns are therefore checked across the whole map *before* any
usage pattern, and always win. It's pinned by tests, and those tests also prove
the underlying collision is real, so the check can't quietly become vacuous.

## Verifying it works

`npm run test:logic` is the gate — it imports only the pure engine files and
runs with no Firestore, no Gemini and no network. Beyond the unit checks it
asserts the entire demo dataset:

```
Amazon Prime      likely-unused  high    ₹2,093   7 charges, zero Amazon orders
Zomato Gold       likely-unused  high    ₹800     4 of 8 charges; orders stopped 115 days ago
Netflix           unknown        low     ₹0       no footprint — we ask instead
KUKU FM PREMIUM   unknown        none    ₹0       unmapped merchant — we ask instead
Swiggy One        used           high    ₹0       6 orders in the last 90 days

Total wasted ₹2,893 · Annual savings ₹5,988
```

Those figures are asserted at four anchor dates through March 2027, because
every seeded date is generated relative to the run date — the demo can't go
stale.

## API

The dashboard's own controls use server actions. These routes exist for
programmatic use and are gated by the `x-owner-key` header when `OWNER_KEY` is
set.

| Route | Purpose |
|---|---|
| `POST /api/extract` | multipart `screenshot` → extracted transactions |
| `POST /api/verdicts/{merchantKey}/answer` | `{ "used": boolean }` |
| `POST /api/proposal` | Generate a plan · `PATCH` with `{ id, status }` to accept or reject |

## Status

P0 is complete: engine, tests, seed, storage, dashboard, evidence chains, gap
handler, screenshot intake and grounded proposals. See `PLAN.md` for what
remains and [`docs/PRD.md`](docs/PRD.md) for the product spec.

Deliberately out of scope: autonomous cancellation (the agent proposes, the
human disposes — a permanent product principle), multi-user accounts, bank and
app-store API integration, and device telemetry.
