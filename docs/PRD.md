# Product Requirements Document (PRD): Project Zombie

## 1. Executive Summary
**Zombie** is a specialized FinTech subscription agent designed to judge subscription value based on actual usage, not just billing cycles. Unlike traditional subscription trackers that merely list recurring charges, Zombie correlates financial transactions with usage evidence (emails, sub-merchant transactions, and user input) to identify "zombie" subscriptions—services the user pays for but no longer uses. The system follows a "Propose, Don't Act" philosophy, ensuring the human user remains the final authority on all financial decisions.

## 2. Problem Statement
Users frequently continue paying for unused subscriptions without realizing the lack of utility. While recurring-charge detection is a solved problem in banking apps, these tools cannot tell a user *if* they are actually using the service. The financial leak occurs because users are not surprised by the charge itself, but by the realization that they stopped using the service months ago. Zombie solves the "unsolved half" of subscription management: usage verification.

## 3. Goals & Objectives
*   **Quantify Waste:** Calculate a "Zombie Score" to rank subscriptions by total money wasted.
*   **Deterministic Trust:** Ensure all financial math and usage verdicts are grounded in auditable code, using AI only for unstructured data extraction and natural language synthesis.
*   **Evidence-Based Verdicts:** Provide a clear "evidence chain" for every recommendation.
*   **Human-in-the-Loop:** Maintain a strict non-autonomous policy where the agent proposes and the human disposes.

## 4. Target Users
**Primary segment:** Digital-first Indian consumers with 8–15 active subscriptions spread across UPI autopay, app-store billing, and cards — three or more billing rails with no single surface showing all of them.

**Proxy user:** This product is built and dogfooded against the author's own real GPay and Gmail transaction history. This is a deliberate choice, not a convenience: every heuristic in the merchant-relationship map is validated against real Indian merchant data rather than assumed, and the primary acceptance test is whether the agent surfaces a subscription the author had genuinely forgotten. An in-segment builder catches the cases a synthetic dataset never would.

## 5. Functional Requirements

### 5.1 Ingestion & Perception
*   **Multimodal Extraction:** Ingest GPay screenshots and receipt emails.
*   **Automated Email Sync:** Connect to Gmail via OAuth to identify billing and activity signals.
*   **Schema Validation:** Use Zod to validate all extracted JSON data from LLM outputs.

### 5.2 Detection (Layer 1)
*   **Deterministic Identification:** Identify recurring charges based on merchant name, 25–35 day cadence, and amount consistency (±10%).

### 5.3 Usage Correlation (Layer 2)
*   **Transaction Correlation (High Confidence):** Map subscription charges to usage evidence (e.g., Amazon Prime → Amazon orders; Zomato Gold → Zomato orders).
*   **Email Engagement Signal (Medium Confidence):** Analyze the ratio of billing invoices vs. product/content emails.
*   **Evidence Gap Handling (Layer 2c):** When signals are low/none, the system must query the user directly rather than guessing.

### 5.4 Verdict & Proposal (Layer 3)
*   **Zombie Scoring:** Rank subscriptions by (Months since last usage × Monthly cost).
*   **Plan Generation:** Generate a natural language plan (Cancel/Downgrade/Keep) with quantified annual savings.
*   **Human Decision Loop:** Provide explicit Accept/Reject actions for every proposal.

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
*   As a user, I can reject a verdict I disagree with and have that correction persist.

## 7. Non-Functional Requirements
*   **Performance:** Deterministic logic (Layer 1 & 2) must execute in <500ms.
*   **Auditability:** Every number on screen must be traceable to a specific transaction or email artifact.
*   **Security:** Single-owner design; Gmail tokens must be scoped and stored securely.
*   **Reliability:** Zero "hallucinated" savings; all currency math must be handled by TypeScript, not the LLM.

## 8. System Architecture Overview
The system follows a left-to-right pipeline:
1.  **Client Layer:** Next.js 16 Web App handles uploads and displays the dashboard.
2.  **Evidence Layer:** Gmail API (inbound) and Web App feed the **Evidence Extractor** (Gemini 3.1 Flash-Lite).
3.  **Data Layer:** Normalized data is stored in **Firestore** via Firebase Admin SDK.
4.  **Logic Layer:** The **Usage Correlation Judge** processes data using a curated merchant map, calculating Zombie Scores and confidence grades.
5.  **Interaction Layer:** The **Evidence Gap Handler** manages user queries for low-confidence verdicts.
6.  **Synthesis Layer:** The **Plan Proposer** (Gemini 3.1 Flash-Lite) generates the final grounded proposal.
7.  **Feedback Loop:** User Accept/Reject actions update Firestore directly.

## 9. Tech Stack
*   **Frontend:** Next.js 16 (App Router), TypeScript, Tailwind CSS, Recharts.
*   **Backend:** Next.js Route Handlers (Server-side logic).
*   **AI/ML:** `gemini-3.1-flash-lite` (Pinned for extraction, classification, and synthesis).
*   **Validation:** Zod.
*   **Database:** Firestore (Firebase Admin SDK).
*   **Integrations:** Gmail API (OAuth 2.0), Gemini API.

## 10. Data Requirements

### Thresholds & Edge Cases
*   **Lookback window:** 90 days for transaction correlation. A subscription with zero correlated activity across the window is flagged likely-unused.
*   **Never-used subscriptions:** Where no usage evidence exists at any point in history, months-idle is measured from the first observed charge rather than from a last-usage date. These rank highest by design.
*   **Insufficient history:** Subscriptions with fewer than two observed charges are not scored; they surface as "detecting" rather than as a verdict.
*   **Confidence grades:** 
    *   **HIGH:** Transaction correlation within the lookback window.
    *   **MEDIUM:** Email engagement ratio only.
    *   **LOW/NONE:** No signal, routes to the Evidence Gap Handler.

### Two-Track Data Strategy
*   **Validation track:** Real GPay and Gmail history, used for dogfooding and for verifying that flagged subscriptions match ones the author recognizes as genuinely unused.
*   **Demonstration track:** A scripted synthetic history with zombies planted at varying confidence levels, generated date-relative so the dataset never goes stale.

## 11. API Specifications
*   **Inbound Evidence:** GET/POST endpoints for Gmail webhook/polling and screenshot uploads.
*   **Gemini Interface:** Single model configuration for `gemini-3.1-flash-lite` used across extraction, unmapped-merchant fallback, and plan generation.
*   **Internal Judge API:** Deterministic TypeScript functions for Layer 1/2 logic.

## 12. Security Requirements
*   **Authentication:** Single-owner passcode protection.
*   **Authorization:** Gmail OAuth 2.0 with restricted scopes (read-only for specific labels/senders).
*   **Data Protection:** Server-side only database access via Firebase Admin SDK; no client-side DB keys.

## 13. Success Metrics
*   **Accuracy:** Correctly flags at least one forgotten subscription in real dogfooding data.
*   **Transparency:** 100% of verdicts have a clickable evidence chain.
*   **Integrity:** Zero discrepancy between "Annual Savings" shown and the sum of identified zombie costs.
*   **Coverage:** Successful classification of 90%+ of top 20 Indian digital service merchants.

## 14. Timeline & Milestones
*   **P0 (Core Pipeline):** Multimodal extraction, Layer 1 detection, Layer 2 correlation (curated map), Zombie Score, Evidence Gap Handler, Grounded Proposals.
*   **P1 (Enhancements):** Gmail OAuth integration, Layer 2b (Email signals), Unmapped-merchant Gemini fallback.
*   **P2 (Future):** PDF bank statement parsing, multi-file batch uploads.

## 15. Non-Goals — Deliberately Out of Scope
*   **Direct bank / app-store API integration:** Avoids aggregator dependencies and compliance overhead.
*   **Autonomous cancellation:** The agent proposes; the human disposes. This is a permanent product principle.
*   **Multi-user accounts:** Single-owner by design to simplify Gmail token scoping.
*   **Conversational chat interface:** The UI is the evidence chain; chat adds no functional value.
*   **Device Telemetry:** Usage is inferred from financial/email evidence only; no device-level tracking.