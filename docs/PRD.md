# Product Requirements Document (PRD): Zombie

## 1. Executive Summary
**Zombie** is a FinTech subscription agent that judges subscriptions by **actual usage**, not billing cycles. Traditional trackers list recurring charges; Zombie correlates those charges against the behavioural footprint a service leaves when it is genuinely used (Amazon orders, Swiggy deliveries, order-confirmation email) to identify "zombie" subscriptions — services paid for but abandoned. Every figure is produced by a deterministic engine; AI is confined to unstructured-data extraction and natural language. The system follows a "propose, don't act" philosophy: the human remains the final authority on every financial decision.

## 2. Problem Statement
Digital-first consumers in India manage 8–15 active subscriptions across UPI autopay, app stores and cards. Recurring-charge detection is a solved problem in banking apps, but those tools cannot tell a user *whether they are still using the service*. The leak is not the charge — users are not surprised by the charge. The leak is the realisation, months late, that they stopped using it. Zombie solves the unsolved half: usage verification.

## 3. Goals & Objectives
*   **Usage-Based Auditing:** Move beyond tracking to active judgment of subscription utility.
*   **Financial Integrity:** Every rupee of "wasted" money ties to a specific transaction ID, never an AI-generated estimate.
*   **Evidence-Based Verdicts:** Every verdict (Used, Likely-Unused, Unknown) carries a clickable evidence chain.
*   **Human-in-the-Loop:** The user makes the cancellation decision; the agent tracks the outcome and corrects itself if it was wrong.

## 4. Target Users / Stakeholders
**Primary segment:** Digital-first Indian consumers with 8–15 active subscriptions spread across UPI autopay, app-store billing and cards — three or more billing rails with no single surface showing all of them.

**Proxy user:** Built and dogfooded against the author's own real GPay and Gmail history. This is deliberate, not convenient: every heuristic in the merchant map is validated against real Indian merchant data rather than assumed, and the primary acceptance test is whether the agent surfaces a subscription the author had genuinely forgotten. An in-segment builder catches cases a synthetic dataset never would.

## 5. Functional Requirements

### Layer 1: Recurring Detection (`src/lib/subscriptions.ts`)
*   **Normalization:** Group transactions by a normalized merchant key to handle drifting UPI payee names ("AMAZON PRIME" vs "Amazon Prime*IN").
*   **Chaining Logic:**
    *   Consecutive charges must be 25–35 days apart.
    *   Amounts must be within ±10% of the previous charge (moving anchor).
    *   Minimum of 3 charges to form a chain.
*   **Gap Handling:** Gaps < 25 days are treated as extra purchases and skipped; gaps > 35 days end the chain.
*   **Status:** Chains unbilled for > 40 days are marked `ended` and excluded from future savings.

This layer is table stakes — every bank app has it. It exists here only to feed Layer 2.

### Layer 2: Usage Correlation (`src/lib/correlate.ts` & `src/lib/merchant-map.ts`)
*   **Footprint Detection:** Match subscription bills against a *separate* financial footprint (Amazon Prime → Amazon orders; Zomato Gold → Zomato orders).
*   **Ordered Precedence (The Contract):** `isUsageEvidence()` applies four tests in this exact order. The order is the entire defence against a subscription citing its own bill as proof it is being used — without it, every verdict returns "used" and the app reports zero zombies silently, with no error and a perfectly reasonable-looking screen:
    1.  Exclude the subscription's own charges (matched by transaction ID).
    2.  A service with **no observable footprint** has no evidence, ever — stop here and hand off to Layer 2c.
    3.  Exclude charges that look like **any** mapped service's billing, not just this one's.
    4.  Finally, match against this service's own usage tokens — contiguous token sequences only, so `ola` does not match "Chocolate Room".
*   **Windows:** The 90-day window and the score are answered from different ranges, deliberately.
    *   `matchesInWindow` — "is there any usage in the last 90 days?" — decides the **verdict**.
    *   `lastUsage` — sought across **all** history — bounds the **score**.
    *   A subscription last used 115 days ago is therefore flagged likely-unused, but only the charges billed after that date are counted. Conflating the two would roughly double the reported waste.

### Layer 2b: Email Intake & Usage Evidence (`src/lib/gmail.ts`, `src/lib/merchant-map.ts`)
*   **Intake:** Read Gmail message bodies to extract billing data (amount, date, merchant) via Gemini and Zod — the same schema a screenshot passes through. Extracted bills appear in the dashboard tagged `Source = mail`.
*   **Evidence:** `isEmailUsageEvidence()` treats order confirmations and dispatch notices as proof of use, mirroring Layer 2's precedence: billing subjects are excluded before any usage subject is considered.
*   **Scope:** Restricted to a user-chosen Gmail label. `gmail.readonly` is required because a bill's **amount lives in the message body** — `gmail.metadata` reads headers only and can never see one.

### Layer 2c: Evidence Gap Handler
Services that leave no transaction footprint are not guessed at. There are two distinct kinds of not-knowing, and the UI keeps them apart:
*   **Recognised but unobservable** (Netflix, Spotify, cloud storage) — 24 of the 32 mapped services. "We know we cannot see this."
*   **Unmapped merchant** — "We do not recognise this at all."
*   **Verdict:** Both return `verdict: unknown` and a `zombieScore` of **₹0**. No evidence means no claim; unanswered unknowns contribute exactly zero to headline totals.
*   **Interaction:** Both raise a direct question to the user.
*   **Answer Precedence:** A user answer yields confidence `user-confirmed` and **outranks every inference, in both directions** — it can mark used what the engine flagged, and unused what the engine cleared. Clearing the answer restores the engine's own verdict.

### Layer 3: Zombie Score & Proposal
*   **Zombie Scoring:** The sum of subscription charges billed *after* the last observed usage evidence — or every charge in the chain where usage was never observed. The unit is rupees and each contributing charge carries its transaction ID, so the savings total reconciles against transaction history by construction rather than by trust.

    This refines the original `months idle × monthly cost` formulation: the same quantity, computed exactly instead of approximated. (The approximation values a 192-day-idle ₹299 subscription at ₹1,913; the exact rule gives ₹2,093, being seven real charges of ₹299.)
*   **Metrics:**
    *   `totalWasted` — sum of all `zombieScore` values.
    *   `annualSavings` — 12 × monthly cost of likely-unused, **active** subscriptions.
    *   `monthlyRunRate` — total monthly cost of all active subscriptions.
*   **Plan Generation:** A natural-language cancel/downgrade/keep plan. Gemini writes the prose; the engine supplies every number.
*   **Human Decision Loop:** Explicit Accept/Reject on every proposal, and a per-item "Done" tick.
*   **Cancellation Tracking:** When a user ticks an item cancelled, it leaves the monthly total. If a charge later arrives for that subscription, the engine self-corrects and returns it to active rather than continuing to claim a saving that did not happen.

### Chat Assistant
*   **Function:** A floating assistant answering questions about the user's own subscription data.
*   **Constraint:** Restricted to pre-computed engine figures; stateless, holding no conversation history.
*   **Safety:** Every figure is computed by the engine *before* the model is called. If the reply contains a figure that was not supplied, the **entire reply is discarded** and a code-authored deterministic answer ships instead.

## 6. User Stories

**Ingest**
*   As a user, I upload a GPay screenshot and see the transactions extracted correctly without retyping anything.
*   As a user, I connect Gmail once and have billing and activity emails read automatically.

**Detect**
*   As a user, I see every recurring charge identified, with cadence and amount shown so I can confirm the detection is right.

**Judge**
*   As a user, I see each subscription marked used or likely-unused, with a confidence grade rather than a bare yes/no.
*   As a user, I click any verdict and see the exact evidence behind it — which transactions were checked, over what window, and what was found.
*   As a user, when the agent has no evidence, I am asked directly rather than given a guess.

**Propose**
*   As a user, I see subscriptions ranked by money wasted to date, not alphabetically or by cost.
*   As a user, I receive a concrete cancel/downgrade/keep plan with a quantified annual savings total.

**Accept**
*   As a user, I accept or reject the plan; nothing is cancelled on my behalf.
*   As a user, I tick an item once I have actually cancelled it, and see the saving reflected in this month and every month after.
*   As a user, I can reject a verdict I disagree with and have that correction persist.

**Review**
*   As a user, I page back to any earlier month and see the verdicts the agent would genuinely have reached then.

## 7. Non-Functional Requirements
*   **Performance:** Subscriptions and verdicts are **never persisted** — they are recomputed from raw transaction history on every request. That is load-bearing, not an optimisation: it is what allows any past month to be replayed, and what allows a declared cancellation to be overturned by a later charge.
*   **Reliability:** 100 engine regression checks must pass locally (`npm run test:logic`) as pure functions with no credentials and no network.
*   **Auditability:** Every number on screen traces to a specific transaction or email artifact.
*   **Accuracy:** Zero discrepancy between headline figures and the sum of the underlying transaction IDs.
*   **Honesty:** Confidence is rendered as words, never percentages. Fake precision would undercut the auditability the product argues for; the `Confidence` type has no numeric field, so a percentage is unrepresentable rather than merely discouraged.

## 8. System Architecture Overview
A five-layer deterministic engine with a strict boundary between AI and logic.
*   **Intake:** GPay screenshots and labelled Gmail flow through Gemini for extraction.
*   **Validation:** Zod validates all AI output before it reaches the database.
*   **Engine:** Five pure files (`types.ts`, `dates.ts`, `merchant-map.ts`, `subscriptions.ts`, `correlate.ts`) perform every calculation.
*   **Guardrails:** An ESLint rule forbids those five files from importing Zod, firebase-admin, the Gemini SDK, React or Next. A drawn boundary is a claim; a lint rule is a guarantee.
*   **Output:** A dashboard with a Month Navigator that re-runs the whole engine as of any past point in time.

## 9. Tech Stack
*   **Framework:** Next.js 16 (App Router), React 19, TypeScript.
*   **Styling:** Tailwind CSS v4.
*   **AI:** Google Gemini `gemini-3.1-flash-lite` (pinned) via `@google/genai`.
*   **Database:** Firestore via Firebase Admin SDK, server-side only, with a local JSON fallback.
*   **Validation:** Zod.
*   **Integrations:** Gmail REST API (OAuth 2.0), via `fetch`.
*   **Deployment:** Vercel.

## 10. Data Requirements

*   **Persisted:** Raw transactions, user answers, cancellation ticks, synced email headers, generated proposals.
*   **Computed, never stored:** Subscriptions, verdicts, waste scores.

### Thresholds & Edge Cases
*   **Lookback window:** 90 days for transaction correlation. Zero correlated activity across the window flags the subscription likely-unused.
*   **Never-used subscriptions:** Where no usage evidence exists at any point in history, every charge in the chain counts as waste, measured from the first observed charge. These rank highest by design.
*   **Insufficient history:** Detection requires three or more charges, so a merchant below that threshold produces no subscription and therefore no verdict to withhold. No separate "detecting" state exists.
*   **Confidence grades:**
    *   **HIGH:** Transaction correlation within the lookback window, or a full 90-day silence.
    *   **MEDIUM:** Available history is shorter than the lookback window, so the silence claim rests on less than a full window.
    *   **LOW:** Recognised service that leaves no observable footprint. Routes to the Evidence Gap Handler.
    *   **NONE:** Merchant not recognised. Also routes to the Gap Handler, but is a weaker admission than LOW.
    *   **USER-CONFIRMED:** The user answered directly. Outranks every inference, in both directions.

### Two-Track Data Strategy
*   **Validation track:** Real GPay and Gmail history, used for dogfooding and for verifying that flagged subscriptions match ones the author recognises as genuinely unused. Restricted to the local JSON store via `ZOMBIE_STORE=local`.
*   **Demonstration track:** Scripted synthetic history with zombies planted at HIGH, MEDIUM and unknown confidence, generated date-relative so the dataset never goes stale. This is what the public deployment serves.

## 11. API Specifications

The dashboard's own controls use **server actions**, not HTTP routes — including the chat assistant (`askAgentAction`) and the Gmail connect flow. That is deliberate: a server action keeps the owner passcode on the server, whereas a browser-issued `fetch` would have to carry it in the client bundle.

The following routes exist for programmatic use and are gated by the `x-owner-key` header when `OWNER_KEY` is set:

| Route | Purpose |
|---|---|
| `POST /api/extract` | multipart `screenshot` → Gemini extraction → Zod validation → transactions |
| `POST /api/proposal` | Generate a plan from engine findings |
| `PATCH /api/proposal` | `{ id, status }` — accept or reject |
| `GET /api/proposal` | Fetch the most recent plan |
| `POST /api/verdicts/[merchant]/answer` | `{ used: boolean }` — record a manual usage confirmation |
| `GET /api/gmail/auth`, `GET /api/gmail/callback` | OAuth handshake |
| `POST /api/gmail/sync` | Fetch labelled mail; return extracted bills and usage evidence |

## 12. Security Requirements
*   **Authentication:** Single-owner passcode. The passcode also rides along as the OAuth `state` parameter, which is how the Gmail callback proves it originated from our own auth route.
*   **Authorization (Gmail):** OAuth 2.0 with the `gmail.readonly` scope. This is stated plainly because it is the widest permission the product asks for: a bill's amount lives in the message **body**, so no header-only scope can read one, and `gmail.metadata` would make Layer 2b intake impossible. Gmail also provides **no label-scoped or sender-scoped OAuth scope** — the grant is mailbox-wide, and the label filter is a promise this code keeps rather than one Google enforces.
*   **Data Protection:** Server-side only database access via Firebase Admin SDK; no client-side DB keys, no security rules to misconfigure.
*   **Data Integrity:** `npm run demo:reset` clears real transactions, answers, cancellations, synced mail and proposals, re-seeds, and **exits non-zero if any figure drifts** from the expected demo outcome.

## 13. Deployment & Infrastructure
*   **Environment Variables:** `GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_PATH` (or `FIREBASE_SERVICE_ACCOUNT_JSON` on Vercel), `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_LABEL`, `GMAIL_MAX_RESULTS`, `OWNER_KEY`, `CHAT_DAILY_LIMIT`, `ZOMBIE_STORE`.
*   **Model Pinning:** the model id is a **code constant** in `src/lib/gemini.ts`, not an environment variable — pinned to `gemini-3.1-flash-lite`. `gemini-2.5-flash` returns 404 for newly issued API keys and the alternatives hang on the free tier.

## 14. Success Metrics
*   **Dogfooding:** Correctly flags at least one genuinely forgotten subscription in the author's real data.
*   **Transparency:** 100% of verdicts carry a clickable evidence chain.
*   **Integrity:** Zero instances of an AI-generated number reaching the UI.
*   **Stability:** 100% pass rate on the engine regression suite.
*   **Coverage:** Successful classification of the top 20 Indian digital service merchants.

## 15. Timeline & Milestones
*   **P0 (Core Pipeline):** Multimodal extraction, Layer 1 detection, Layer 2 correlation, Zombie Score, Evidence Gap Handler, grounded proposals. **Shipped.**
*   **P1 (Enhancements):** Gmail OAuth, Layer 2b email intake and engagement signal. **Shipped.**
*   **P2 (Shipped beyond plan):** Month Navigator, cancellation tracking, chat assistant.
*   **P3 (Future):** PDF bank statement parsing, multi-file batch upload, unmapped-merchant Gemini fallback.

## 16. Non-Goals — Deliberately Out of Scope
*   **Direct bank / app-store API integration:** Avoids aggregator dependencies and compliance overhead.
*   **Autonomous cancellation:** The agent proposes; the human disposes. A permanent product principle.
*   **Multi-user accounts:** Single-owner by design, which simplifies Gmail token scoping.
*   **Device telemetry:** Usage is inferred from financial and email evidence only.
*   ~~**Conversational chat interface**~~ — **reversed, and shipped.** The original reasoning was that the UI *is* the evidence chain and chat adds no functional value. That still holds for *analysis*: the chat cannot reach a conclusion the dashboard does not already show. What it adds is reach — asking "how much did I waste" is faster than reading three tiles. It is constrained accordingly: the engine computes every figure before the model is invoked, and any reply containing a number that was not supplied is discarded whole rather than shown. The assistant can restate the dashboard; it cannot out-run it.

## 17. Open Questions & Risks
*   **Gmail scope:** `gmail.readonly` is mailbox-wide; label filtering is a code-level promise, not a Google-enforced restriction. Stated openly rather than papered over.
*   **Seasonal usage:** A 90-day window may flag genuinely seasonal subscriptions (an annual sports pass) as zombies.
*   **Unmapped services:** Services outside the 32-merchant map receive the weakest confidence grade and always route to a question.

---

### Seeded Demo Data (Reference Figures)

| Subscription | Verdict | Confidence | Score | Note |
|---|---|---|---|---|
| Amazon Prime | likely-unused | high | ₹2,093 | 7 charges, zero Amazon orders anywhere in history |
| Zomato Gold | likely-unused | high | ₹800 | 4 of 8 charges; orders stopped 115 days ago |
| Netflix | unknown | low | ₹0 | no footprint — ₹3,894 at stake, so we ask |
| KUKU FM Premium | unknown | none | ₹0 | unmapped merchant — ₹396 at stake, so we ask |
| Swiggy One | used | high | ₹0 | 6 orders in the last 90 days |

**Totals:** ₹2,893 wasted to date · ₹5,988 annual potential savings · ₹1,746 monthly run rate.

These are asserted by `npm run test:logic` at four separate anchor dates through
March 2027. Every seeded date is generated relative to the run date, so the demo
cannot go stale.
