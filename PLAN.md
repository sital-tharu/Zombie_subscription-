

# Zombie — build plan

Working document for the Grand Finale build. `CLAUDE.md` holds the rules and
architecture; this holds the sequence, the contracts, and what "done" means.

**Final submission: 8 Aug 2026, 3:30 PM IST.**
Second free review: repo to Dr. Agent by **6 Aug, 9:00 PM IST**.

---

## Status

- [x] Architecture diagram + PRD submitted (Aug 4 gate)
- [x] Layer 1 recurring detection — `src/lib/subscriptions.ts`
- [x] Layer 2 usage correlation + zombie score — `src/lib/correlate.ts`
- [x] Merchant map, 21 Indian services — `src/lib/merchant-map.ts`
- [x] Engine regression tests, 15 checks — `scripts/test-logic.ts`
- [ ] Seed script
- [ ] Firestore read/write
- [ ] Dashboard UI
- [ ] Evidence Gap Handler flow
- [ ] Gemini intake route
- [ ] Plan proposal
- [ ] README + demo video

---

## Build sequence

Order matters: data before UI, UI before intake. Nothing that puts an LLM in
the path of a number.

### 1. Seed script (~1h) — `scripts/seed.ts`

Date-relative synthetic history written to Firestore. Every date generated
from the current date so the demo never goes stale. Must plant the full demo
arc:

| Merchant | Pattern | Expected verdict |
|---|---|---|
| Amazon Prime | ₹299/mo × 7 months, **zero** Amazon purchases | likely-unused, HIGH, ~₹2,093 |
| Swiggy One | ₹499/mo × 6 months, Swiggy orders throughout | used, HIGH, ₹0 |
| Zomato Gold | ₹200/mo × 8 months, Zomato orders stop ~120d ago | likely-unused, HIGH, ~₹800 |
| Netflix | ₹649/mo × 6 months | unknown, LOW → gap handler |
| Kuku FM Premium | ₹99/mo × 4 months, unmapped merchant | unknown, NONE → gap handler |

Plus 40–60 background transactions across Food, Transport, Shopping and
Utilities so the history looks real and the correlation has noise to reject.

**Done when:** `analyze()` over the seeded data returns the table above, and
the numbers are checked by hand before any UI exists.

### 2. Firestore layer (~0.5h) — `src/lib/firestore.ts`

Lifted from Rupee Radar. Collections:

- `transactions/{id}` — `{ merchant, date, total, category, source, createdAt, seeded? }`
- `verdicts/{merchantKey}` — cached `UsageVerdict` plus `userAnswer`, `answeredAt`
- `proposals/{id}` — `{ findings, planText, annualSavings, status, createdAt }`

`status` is one of `pending | accepted | rejected`.

### 3. Dashboard UI (~2.5h) — `src/app/page.tsx`

Server-rendered. Top to bottom:

1. **Headline** — total wasted to date, and annual savings if every
   likely-unused subscription were cancelled. Both from `analyze()`.
2. **Ranked list** — one card per subscription, ordered by `zombieScore`
   descending. Each shows merchant, monthly amount, verdict badge, confidence
   badge, and money wasted.
3. **Evidence chain** — expanding a card shows exactly why: which usage
   merchants were searched, over what window, what was found, and the
   individual charges that make up the waste figure. Every rupee links to a
   transaction. **This is demo beat #4 — it must be one click.**
4. **Gap handler queue** — subscriptions the agent cannot judge, each with its
   question and Yes / No buttons.

Verdict badges: `likely-unused` red, `used` green, `unknown` amber.
Confidence rendered as a word (High / Medium / Low), never a percentage —
a fake precision number undercuts the whole honesty argument.

### 4. Gap handler flow (~1h)

`POST /api/verdicts/[merchant]/answer` with `{ used: boolean }`. Writes
`userAnswer` to the verdict doc. A "no" promotes the verdict to
`likely-unused` with confidence `user-confirmed` and prices the waste from
the full charge chain. A "yes" sets it to `used`, score 0.

The user's answer always outranks inference. Persist it — demo beat #5 is the
agent asking, and the answer sticking.

### 5. Gemini intake (~1.5h) — `POST /api/extract`

Lifted from Rupee Radar's `extract.ts` and `gemini.ts`, near-intact.
Screenshot → `responseJsonSchema` → Zod → `transactions` collection.
Model stays pinned to `gemini-3.1-flash-lite`.

### 6. Plan proposal (~1.5h) — `POST /api/proposal`

Send Gemini the **already-computed** ranked findings and ask only for prose:
a cancel / downgrade / keep recommendation per subscription and a short
summary. The annual savings total is computed in code and passed in, never
requested from the model.

Prompt must state that every figure is given and must be reproduced exactly.
Validate the response with Zod. If a number appears that isn't in the input,
drop the response and fall back to a templated plan.

Accept / reject writes `status` to the proposal doc.

---

## P1 — only if the schedule holds

- Gmail OAuth + Layer 2b email engagement signal. OAuth on a fresh deployment
  is a known time sink; the system degrades cleanly to the gap handler without it.
- Unmapped-merchant Gemini fallback classifier.

## Explicitly out

Chat agent, multi-user auth, autonomous cancellation, bank/app-store
integration, device telemetry, PDF statement parsing, multi-file upload.

---

## Demo script — 6 minutes

1. **The pain.** "I can list my subscriptions. I can't tell you which ones I
   actually use."
2. **Subscriptions found.** Move fast — this is table stakes.
3. **The reveal.** Three flagged, ranked by money wasted. Land the line:
   *"₹2,093 on Prime since January. Zero Amazon orders."*
4. **The evidence chain.** One click. Not a black box.
5. **The honest moment.** The agent asks about Netflix, because it genuinely
   cannot know. Say out loud that knowing its own limits is the point.
6. **Accept the plan.** Annual savings total lands.
7. **Architecture.** Deterministic verdicts, AI only for intake and language —
   a deliberate engineering choice, not a limitation.

---

## Verification before submission

- `npm run test:logic` passes.
- Seed → deploy → load the live URL → zombie verdicts, evidence chains and
  savings totals all render correctly.
- Dogfood against real GPay history; confirm flagged subscriptions are ones
  genuinely recognised as unused. **If it catches one that was forgotten, it
  works.**
- Clean clone runs from the README with no undocumented steps.
- Repo contains `docs/PRD.md`, `docs/architecture.md`, README, full source.
