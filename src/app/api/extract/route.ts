import { requireOwner } from "@/lib/auth";
import { hasGeminiKey } from "@/lib/gemini";
import { ingestScreenshot } from "@/lib/ingest";

/**
 * POST /api/extract   multipart/form-data with a `screenshot` image
 *
 * Screenshot to structured transactions, via Gemini and then through Zod before
 * anything is stored. Extraction is the widest part of the funnel and the only
 * place unverified data can enter, so validation failures are surfaced as
 * errors rather than quietly dropping rows into the history that every figure
 * on the dashboard is computed from.
 */
export const maxDuration = 60;

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const denied = requireOwner(request);
  if (denied) return denied;

  if (!hasGeminiKey()) {
    return Response.json(
      { error: "GEMINI_API_KEY is not set, so screenshot intake is unavailable." },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const file = form.get("screenshot");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "Attach an image as `screenshot`." }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return Response.json({ error: "That file is not an image." }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "Image exceeds 8 MB." }, { status: 413 });
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const { added, transactions } = await ingestScreenshot(bytes, file.type);
    return Response.json({ added, transactions });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Extraction failed." },
      { status: 502 },
    );
  }
}
