/**
 * Multimodal intake: a Google Pay screenshot becomes structured transactions.
 *
 * This is one of only three jobs Gemini has, and note what it is: reading, not
 * reasoning. The model transcribes what is on the screen. It does not decide
 * whether anything is a subscription, it does not judge usage, and nothing it
 * returns is trusted until Zod has validated it.
 */
import { getGeminiClient, GEMINI_MODEL } from "./gemini";
import { todayIso } from "./dates";
import {
  CATEGORIES,
  ExtractionSchema,
  type ExtractedTransaction,
} from "./schemas";

/**
 * A response schema, rather than a request to "reply with JSON". Constraining
 * the decoder is far more reliable than asking politely, and it means Zod is
 * catching genuine surprises rather than routine formatting noise.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          merchant: { type: "string" },
          date: { type: "string" },
          total: { type: "number" },
          category: { type: "string", enum: [...CATEGORIES] },
        },
        required: ["merchant", "date", "total", "category"],
      },
    },
  },
  required: ["transactions"],
};

function buildPrompt(asOf: string): string {
  return [
    "Extract every payment visible in this screenshot.",
    "",
    "The image is usually a Google Pay or UPI transaction history, so:",
    "- One screen normally shows MANY payments. Return every one you can read.",
    "- The merchant is the UPI payee name exactly as displayed. Keep it verbatim,",
    "  including prefixes like RAZORPAY* or suffixes like *IN. Do not tidy it up,",
    "  expand abbreviations, or guess the brand behind it.",
    "- Amounts are Indian rupees. Return a positive number with no symbol.",
    "- There are usually no line items. Do not invent any.",
    "",
    `Today is ${asOf}. Resolve relative dates against it, so "Yesterday" becomes`,
    "the calendar date. Return every date as YYYY-MM-DD. If a payment shows only",
    "a day and month, assume the most recent occurrence that is not in the future.",
    "",
    "Skip money RECEIVED, refunds, and self-transfers — only outgoing payments.",
    "If a value is genuinely unreadable, omit that payment rather than guessing.",
  ].join("\n");
}

export interface ExtractInput {
  bytes: Buffer;
  mimeType: string;
  /** Injectable for tests and for resolving relative dates deterministically. */
  asOf?: string;
}

/**
 * Returns validated transactions. Throws when the model's output cannot be
 * trusted, which the caller surfaces as a failed upload -- silently dropping
 * malformed rows would put unverified data into the history that every figure
 * on the dashboard is computed from.
 */
export async function extractTransactions(
  input: ExtractInput,
): Promise<ExtractedTransaction[]> {
  const asOf = input.asOf ?? todayIso();

  const response = await getGeminiClient().models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: buildPrompt(asOf) },
          {
            inlineData: {
              mimeType: input.mimeType,
              data: input.bytes.toString("base64"),
            },
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error("Gemini returned an empty response.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned text that is not valid JSON.");
  }

  const result = ExtractionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Extraction failed validation: ${result.error.issues[0]?.message}`);
  }

  // A future-dated payment means a misread date, not a real charge. Dropping it
  // here keeps it out of the charge chains rather than letting it quietly
  // extend one.
  return result.data.transactions.filter((txn) => txn.date <= asOf);
}
