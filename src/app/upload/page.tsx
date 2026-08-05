import { UploadForm } from "@/components/upload-form";
import { hasGeminiKey } from "@/lib/gemini";

// hasGeminiKey reads the environment at request time, and a build-time snapshot
// would show the wrong state on a deployment whose key was added afterwards.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Add a screenshot — Zombie",
};

export default function UploadPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold">Add a payment screenshot</h1>
      <p className="mt-2 text-[13px] text-[var(--color-muted)]">
        Gemini reads the payee names, dates and amounts off the image. That is the only
        thing it does here — every verdict, every window and every rupee downstream is
        computed in TypeScript from what it read.
      </p>

      <div className="mt-6">
        <UploadForm hasGeminiKey={hasGeminiKey()} />
      </div>

      <p className="mt-8 border-t border-[var(--color-edge)] pt-5 text-xs text-[var(--color-dim)]">
        Images are sent to Gemini for reading and are not stored. Only the extracted
        payee, date and amount are kept.
      </p>
    </main>
  );
}
