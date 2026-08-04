"use client";

import { useRef, useState, useTransition } from "react";
import { uploadAction } from "@/app/actions";

/**
 * Screenshot intake. Gemini reads the image; everything downstream of it is
 * deterministic, and the extracted rows are validated by Zod before they are
 * allowed anywhere near a charge chain.
 */
export function UploadScreenshot() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setResult(null);

    const formData = new FormData();
    formData.set("screenshot", file);
    startTransition(async () => {
      setResult(await uploadAction(formData));
      if (inputRef.current) inputRef.current.value = "";
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
        id="screenshot-input"
      />
      <label
        htmlFor="screenshot-input"
        className={`cursor-pointer rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-muted)] ${pending ? "pointer-events-none opacity-60" : ""}`}
      >
        {pending ? "Reading screenshot…" : "Add a GPay screenshot"}
      </label>
      {result && (
        <span
          className={`text-sm ${result.ok ? "text-[var(--color-alive)]" : "text-[var(--color-zombie)]"}`}
        >
          {result.message}
        </span>
      )}
    </div>
  );
}
