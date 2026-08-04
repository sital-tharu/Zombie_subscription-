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

- **Gemini does:** read screenshots and receipt emails, classify unrecognised
  merchants, and write the prose of the final plan.
- **Code does:** recurring detection, usage inference, every verdict, and every
  rupee.

A `zombieScore` is the **sum of the actual charges billed after the last piece
of usage evidence**. Its unit is rupees and every rupee carries the transaction
id it came from, so the savings headline reconciles against the charge history
by construction rather than by trust. An LLM that invents a savings figure is
worse than useless in a money product.

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
npm run test:logic           # engine regression checks — needs no credentials
npm run seed                 # scripted demo history with planted zombies
npm run dev                  # localhost:3000
```

Firestore is optional for local development. With no service account
configured, the app falls back to a JSON store under `./data`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on localhost:3000 |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run lint` | ESLint, including the engine purity boundary |
| `npm run test:logic` | Engine regression checks — pure functions, no creds |
| `npm run seed` | Seed date-relative demo history |

## Architecture

Three layers, described in full in [`docs/architecture.md`](docs/architecture.md):

1. **Recurring detection** — same merchant, 25–35 day cadence, amount within
   ±10%, 3+ occurrences. Table stakes.
2. **Usage correlation** — subscription-to-usage merchant mapping over a 90-day
   lookback. The differentiator.
3. **Zombie score and proposal** — rupees traceable to transaction ids, ranked,
   turned into language by Gemini but never into numbers.

See [`docs/PRD.md`](docs/PRD.md) for the product spec.

## Status

Under active construction. See `PLAN.md` for the build sequence.
