/**
 * The only file in the project that imports Zod.
 *
 * Everything crossing the boundary from an LLM or an HTTP request is validated
 * here before it reaches deterministic logic. The engine types in types.ts are
 * plain interfaces and are NOT derived from these schemas -- that inversion is
 * what keeps Layers 1-3 free of a Zod dependency, and it is enforced by an
 * ESLint rule rather than by good intentions.
 *
 * `satisfies` is used to assert compatibility in the one direction that
 * matters: a validated payload has to be assignable to the engine's view of a
 * transaction.
 */
import { z } from "zod";
import { ISO_DATE } from "./dates";
import type { TransactionLike } from "./types";

export const CATEGORIES = [
  "Food",
  "Transport",
  "Subscriptions",
  "Shopping",
  "Utilities",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * One transaction as extracted from a screenshot or receipt email.
 *
 * `category` is the model's own labelling and is carried for display only. The
 * engine never reads it -- TransactionLike deliberately omits the field -- so a
 * miscategorised row can never move a currency figure.
 *
 * `currency` is the opposite: it exists precisely BECAUSE it moves one. Without
 * it a "$20.00" receipt validated cleanly as `total: 20` and was rendered "₹20",
 * because the symbol had nowhere to live and was dropped here. The model is
 * asked only to report the symbol it can see; conversion happens in currency.ts,
 * from a rate no model ever supplies.
 *
 * Case-insensitive, and normalised on read by `currencyOf` rather than by a Zod
 * transform -- one less place for the validated shape to differ from the stored
 * one. The default keeps a model that omits the field from failing an entire
 * upload, and is correct: every rupee-only source (GPay) would have said INR.
 */
export const ExtractedTransactionSchema = z.object({
  merchant: z.string().min(1).max(200),
  date: z.string().regex(ISO_DATE, "date must be YYYY-MM-DD"),
  total: z.number().positive(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO 4217 code")
    .default("INR"),
  category: z.enum(CATEGORIES),
});

export type ExtractedTransaction = z.infer<typeof ExtractedTransactionSchema>;

/**
 * A GPay screenshot is a list, not a single receipt: one screen shows many
 * payments, each with a payee and an amount and usually no line items at all.
 */
export const ExtractionSchema = z.object({
  transactions: z.array(ExtractedTransactionSchema).max(60),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

/** POST /api/verdicts/[merchant]/answer */
export const AnswerRequestSchema = z.object({
  used: z.boolean(),
});

/**
 * Gemini's contribution to the proposal: prose, and nothing else.
 *
 * Note what this schema does NOT contain -- no amount, no total, no saving, no
 * count. The model is handed the finished figures and asked only to write
 * around them. There is no field here for a number to arrive in, which is the
 * strongest available guarantee that an invented one cannot reach the screen.
 */
export const ProposalItemSchema = z.object({
  merchantKey: z.string().min(1),
  action: z.enum(["cancel", "downgrade", "keep", "check"]),
  rationale: z.string().min(1).max(400),
});

export const ProposalResponseSchema = z.object({
  summary: z.string().min(1).max(800),
  items: z.array(ProposalItemSchema).max(20),
});

export type ProposalResponse = z.infer<typeof ProposalResponseSchema>;

/** Compile-time proof that a validated row is usable by the engine. */
export function toTransactionLike(
  id: string,
  extracted: ExtractedTransaction,
): TransactionLike {
  return {
    id,
    merchant: extracted.merchant,
    date: extracted.date,
    total: extracted.total,
  } satisfies TransactionLike;
}
