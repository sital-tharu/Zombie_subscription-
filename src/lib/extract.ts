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

  return validate(response.text, asOf);
}

/**
 * Parse, validate, and drop anything dated after `asOf`.
 *
 * Shared by both intake paths on purpose. A screenshot and a receipt email are
 * read by the same model under the same schema, so they must be trusted to
 * exactly the same degree -- a second, laxer validation for email would be a
 * quiet hole in the one boundary that keeps unverified data out of the charge
 * chains.
 */
function validate(raw: string | undefined, asOf: string): ExtractedTransaction[] {
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

/**
 * The same job, done on the text of a receipt email.
 *
 * Deliberately narrow: ONE payment per message, or none. A billing email
 * announces a single charge, and a model invited to return a list will happily
 * turn an order summary's line items into four separate transactions -- which
 * Layer 1 would then try to chain.
 *
 * Marketing mail gets labelled by accident all the time, so returning nothing
 * has to be a normal, expected outcome rather than an error.
 */
export async function extractTransactionsFromText(
  body: string,
  receivedOn: string,
  asOf: string = todayIso(),
): Promise<ExtractedTransaction[]> {
  const prompt = [
    "This is the text of one email. Decide whether it is telling the user they",
    "were CHARGED a specific amount -- a receipt, invoice, payment confirmation",
    "or subscription renewal notice.",
    "",
    "If it is, return exactly ONE transaction:",
    "- merchant: the service being paid for, as the email names it. Keep it",
    "  verbatim; do not expand abbreviations or guess a parent brand.",
    "- total: the amount actually charged, as a positive number, no symbol.",
    "  If several figures appear, take the one the customer paid -- not a",
    "  subtotal, not tax, not a discount, not a future price.",
    "- date: the date of the charge as YYYY-MM-DD. If the text does not state",
    `  one, use ${receivedOn}, the date the email arrived.`,
    "",
    "Return an EMPTY list if it is anything else: a delivery update, an order",
    "confirmation with no payment taken, a promotion, a reminder to pay, a",
    "newsletter, or a security alert. Returning nothing is a normal outcome and",
    "is far better than guessing.",
    "",
    "Amounts are Indian rupees unless the text says otherwise. Never invent a",
    "figure that does not appear in the text.",
    "",
    "--- EMAIL TEXT ---",
    body.slice(0, 12_000),
  ].join("\n");

  const response = await getGeminiClient().models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  return validate(response.text, asOf);
}
