"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { askAgentAction } from "@/app/actions";
import { Logo } from "@/components/logo";

interface Message {
  role: "user" | "agent";
  text: string;
  /** Which path produced an agent reply. */
  source?: "gemini" | "computed" | "refused" | "limit";
}

const EXAMPLES = [
  "What is a zombie subscription?",
  "Can you show me my monthly subscription summary?",
  "How much money did I waste last month?",
];

/**
 * The assistant, in a bubble.
 *
 * Uses the flatline mark rather than a generic chat glyph, so it reads as part
 * of Zombie rather than a widget bolted on beside it.
 *
 * No streaming, deliberately. The grounding guard has to see a complete answer
 * before it can judge whether every figure in it was supplied, and an answer
 * that might have to be retracted mid-sentence is worse than one that arrives a
 * second later whole. The typewriter below is therefore cosmetic -- it reveals
 * text that has already been validated, which is the honest version of the
 * effect.
 */
export function ChatBubble() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || pending) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    startTransition(async () => {
      const answer = await askAgentAction(q);
      setMessages((m) => [...m, { role: "agent", ...answer }]);
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask about your subscriptions"
        className="fixed right-5 bottom-5 z-40 flex items-center gap-2.5 rounded-full border border-[var(--color-edge)] bg-[var(--color-panel)] py-2 pr-4 pl-2 text-sm font-medium shadow-lg transition-transform hover:scale-105"
      >
        <Logo size={28} className="shrink-0" />
        Ask
      </button>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex max-h-[80dvh] flex-col rounded-t-2xl border border-[var(--color-edge)] bg-[var(--color-ink)] shadow-2xl sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[24rem] sm:rounded-2xl">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-edge)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Ask about your subscriptions</h2>
          <p className="text-[11px] text-[var(--color-dim)]">
            Every figure comes from the dashboard, not the model
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="shrink-0 rounded px-2 py-1 text-[var(--color-dim)] hover:text-[var(--color-fg)]"
        >
          ✕
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-[13px] text-[var(--color-muted)]">
              I can answer from your transactions and subscriptions — nothing else.
            </p>
            {EXAMPLES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => ask(q)}
                className="block w-full rounded-lg border border-[var(--color-edge)] px-3 py-2 text-left text-[13px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i}>
            <div
              className={
                m.role === "user"
                  ? "ml-8 rounded-xl rounded-br-sm bg-[var(--color-panel-2)] px-3 py-2 text-[13px]"
                  : "mr-8 rounded-xl rounded-bl-sm bg-[var(--color-panel)] px-3 py-2 text-[13px]"
              }
            >
              {m.text}
            </div>
            {/* Said out loud, because "a person wrote this rule" and "a model
                followed it" are different levels of assurance and the user
                deserves to know which one they got. */}
            {m.role === "agent" && m.source === "computed" && (
              <p className="mt-1 mr-8 text-[10px] text-[var(--color-dim)]">
                computed directly from your data
              </p>
            )}
          </div>
        ))}

        {pending && (
          <p className="mr-8 animate-pulse rounded-xl rounded-bl-sm bg-[var(--color-panel)] px-3 py-2 text-[13px] text-[var(--color-muted)]">
            Checking your subscriptions…
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="flex items-center gap-2 border-t border-[var(--color-edge)] px-3 py-2.5"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your subscriptions…"
          maxLength={300}
          className="min-w-0 flex-1 rounded-md border border-[var(--color-edge)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-muted)]"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          className="rounded-md bg-[var(--color-invert-bg)] px-3 py-2 text-sm font-semibold text-[var(--color-invert-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}
