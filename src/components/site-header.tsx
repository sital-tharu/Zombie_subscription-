import Link from "next/link";
import { GmailSync } from "@/components/gmail-sync";
import { Logo } from "@/components/logo";
import { ownerKeyConfigured } from "@/lib/auth";
import { hasGeminiKey } from "@/lib/gemini";
import { gmailLabel } from "@/lib/gmail";
import { hasGmailCredentials, isGmailConnected } from "@/lib/gmail-auth";

/**
 * One header for every page.
 *
 * The intake controls used to sit inside the month navigator, next to the
 * ‹ August 2026 › arrows -- which put "add a screenshot" and "sync my mail"
 * inside a widget about which month you are looking at. They are not about the
 * month. They are how data gets into the app at all, so they belong beside the
 * name of the app, in the one strip that is the same on every page.
 *
 * A server component, so the Gmail connection state is read per request and the
 * button says what is actually true. `isGmailConnected` swallows its own errors
 * and returns false, so an unreachable store degrades this to "Connect" rather
 * than taking down every page that renders a header.
 */
export async function SiteHeader() {
  const gmailReady = hasGmailCredentials();
  const gmailConnected = gmailReady ? await isGmailConnected() : false;

  return (
    <header className="border-b border-[var(--color-edge)]">
      <nav className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-3 px-6 py-3">
        {/* Home. The wordmark is the link, so there is always a way back to the
            dashboard from /upload without hunting for one. */}
        <Link href="/" className="flex items-center gap-2.5" aria-label="Zombie dashboard">
          <Logo size={30} className="shrink-0" />
          <span className="font-mono text-xs tracking-widest text-[var(--color-muted)]">
            ZOMBIE
          </span>
        </Link>

        {/* Everything after this is pushed right. A spacer rather than ml-auto
            on the first control, because that control disappears without a
            Gemini key and the alignment would go with it. */}
        <span className="ml-auto" aria-hidden="true" />

        {hasGeminiKey() && (
          <Link
            href="/upload"
            className="rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors hover:border-[var(--color-muted)]"
          >
            + Add a screenshot
          </Link>
        )}

        {/* Renders a fragment: the button group, then any result message as a
            basis-full item. Placed directly in this row rather than inside a
            wrapper so that full-width means the header's width, which is what
            lets a long message wrap underneath instead of stretching the row. */}
        <GmailSync
          configured={gmailReady}
          protectedByKey={ownerKeyConfigured()}
          connected={gmailConnected}
          label={gmailLabel()}
        />
      </nav>
    </header>
  );
}
