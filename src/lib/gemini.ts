import { GoogleGenAI } from "@google/genai";

/**
 * Pinned, and not up for relitigation: gemini-2.5-flash 404s for newly issued
 * API keys and the alternatives hang on the free tier. If extraction starts
 * hanging or 404ing, run `scripts/probe-gemini.ts` and check latency before
 * changing anything else.
 */
export const GEMINI_MODEL = "gemini-3.1-flash-lite";

let client: GoogleGenAI | null = null;

export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function getGeminiClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set — add it to .env.local");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}
