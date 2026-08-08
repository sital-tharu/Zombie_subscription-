/**
 * Answering one question, with the grounding guard as the gate.
 *
 * The order matters and is the whole design: compute first, generate second,
 * validate third, and prefer the code-authored answer whenever the generated
 * one cannot be trusted. Gemini is never the only thing standing between a user
 * and a figure about their own money.
 */
import {
  answerIsGrounded,
  buildChatContext,
  buildChatPrompt,
  deterministicAnswer,
  MAX_QUESTION_CHARS,
  REFUSAL,
} from "./chat";
import { analyze } from "./correlate";
import { configuredRates, toEngineRows } from "./currency";
import { GEMINI_MODEL, getGeminiClient, hasGeminiKey } from "./gemini";
import { getStore } from "./store";

/** Daily ceiling on assistant replies. A floor under cost, not rate limiting. */
export const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT) || 200;

export interface ChatAnswer {
  text: string;
  /** Which path produced it. Surfaced in the UI, because it is worth knowing. */
  source: "gemini" | "computed" | "refused" | "limit";
}

export async function askAgent(question: string): Promise<ChatAnswer> {
  const trimmed = question.trim().slice(0, MAX_QUESTION_CHARS);
  if (!trimmed) return { text: "Ask me something about your subscriptions.", source: "refused" };

  const store = await getStore();

  if (!(await store.consumeQuota("chat", CHAT_DAILY_LIMIT))) {
    return {
      text: "The assistant has hit its limit for today. Everything on the dashboard still works — the figures there are the same ones I answer from.",
      source: "limit",
    };
  }

  // Every read goes through the Store's ten-second cache, so a question asked
  // just after a page render costs no extra database reads at all. The donor
  // project reads two hundred documents per message and can exhaust Firestore's
  // daily free tier from chat alone.
  const [transactions, answers, cancellations, emails] = await Promise.all([
    store.listTransactions(),
    store.listAnswers(),
    store.listCancellations(),
    store.listEmails(),
  ]);

  // Foreign money is priced into rupees here, before the engine sees it, and a
  // row with no configured rate is dropped rather than counted at face value.
  // The assistant can only ever restate figures the engine produced, so keeping
  // this in step with the dashboard is what stops chat quoting a total the
  // screen disagrees with.
  const { rows } = toEngineRows(transactions, configuredRates());

  const result = analyze(rows, undefined, { answers, cancellations, emails });
  const ctx = buildChatContext(result, result.transactionsAnalysed);

  // Computed BEFORE the model is called, so there is always something true to
  // fall back to and the fallback is never a rushed afterthought.
  const computed = deterministicAnswer(ctx, trimmed);

  if (!hasGeminiKey()) {
    return computed
      ? { text: computed, source: "computed" }
      : { text: REFUSAL, source: "refused" };
  }

  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: buildChatPrompt(ctx, trimmed),
      config: { temperature: 0.3, maxOutputTokens: 400 },
    });
    const text = response.text?.trim();

    if (text && answerIsGrounded(text, ctx)) {
      return { text, source: "gemini" };
    }
    // Ungrounded: the WHOLE reply goes, not the offending sentence. A model
    // that invented one figure has not earned trust for the rest of it.
    return computed
      ? { text: computed, source: "computed" }
      : { text: REFUSAL, source: "refused" };
  } catch {
    return computed
      ? { text: computed, source: "computed" }
      : {
          text: "I could not reach the assistant just now. The dashboard figures are unaffected.",
          source: "refused",
        };
  }
}
