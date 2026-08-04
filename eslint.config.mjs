import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * The verdict engine (Layers 1-3) must stay pure and framework-free so that
 * `npm run test:logic` runs with no Firestore or Gemini credentials. That is a
 * promise the codebase can't keep by convention alone -- one stray
 * `import { z } from "zod"` in correlate.ts and the test suite starts needing
 * an environment. So the boundary is a lint error, not a code review note.
 *
 * Zod lives in src/lib/schemas.ts, firebase-admin in src/lib/firestore.ts, and
 * neither is reachable from the five files below.
 */
const ENGINE_FILES = [
  "src/lib/types.ts",
  "src/lib/dates.ts",
  "src/lib/merchant-map.ts",
  "src/lib/subscriptions.ts",
  "src/lib/correlate.ts",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ENGINE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "zod",
                "firebase-admin",
                "firebase-admin/*",
                "@google/genai",
                "next",
                "next/*",
                "react",
                "react-dom",
                "@/lib/schemas",
                "@/lib/firestore",
                "@/lib/store",
                "@/lib/gemini",
              ],
              message:
                "The verdict engine must stay pure so test:logic needs no credentials. Keep Zod in schemas.ts and firebase-admin in firestore.ts.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
