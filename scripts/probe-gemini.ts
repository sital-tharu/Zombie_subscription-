/**
 * Probe the Gemini configuration:
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-gemini.ts
 *
 * Checks that the key authenticates and measures round-trip latency for the
 * pinned model. CLAUDE.md records that gemini-2.5-flash 404s for new API keys
 * and that alternatives hang on the free tier, so when extraction misbehaves
 * this is the first thing to run -- probe latency before changing anything else.
 */
import "./load-env";
import { GEMINI_MODEL, getGeminiClient } from "../src/lib/gemini";

async function main(): Promise<void> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("GEMINI_API_KEY is not set. Add it to .env.local.");
    process.exit(1);
  }

  console.log(`key    : ${key.slice(0, 6)}...${key.slice(-4)} (${key.length} chars)`);
  if (!key.startsWith("AIza")) {
    // Informational only. Most AI Studio keys start with AIza, but other
    // credential shapes authenticate fine -- the live call below is the only
    // thing that actually settles it, so don't treat the prefix as a verdict.
    console.log("note   : unusual key prefix; the call below is what decides.");
  }
  console.log(`model  : ${GEMINI_MODEL}`);

  const started = Date.now();
  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: "Reply with the single word: ok",
    });
    console.log(`latency: ${Date.now() - started} ms`);
    console.log(`reply  : ${response.text?.trim()}`);
    console.log("\nGemini is reachable. Screenshot intake and plan prose will use the model.");
  } catch (error) {
    console.error(`\nfailed after ${Date.now() - started} ms`);
    console.error(error instanceof Error ? error.message : error);
    console.error(
      "\nThe app still works: intake is optional and the proposal falls back to a\n" +
        "deterministic templated plan built from the same computed figures.",
    );
    process.exit(1);
  }
}

main();
