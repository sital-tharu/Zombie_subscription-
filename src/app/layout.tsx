import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ChatBubble } from "@/components/chat-bubble";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

// The header reports whether Gmail is connected, which is per-request state.
// A build-time snapshot would show "Connect" to someone who already had.
export const dynamic = "force-dynamic";

// Geist Sans for prose, Geist Mono for every figure. The mono face is doing
// real work: money that shifts width as digits change reads as unreliable, and
// this product's whole argument is that its numbers can be trusted.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zombie — subscriptions you pay for but don't use",
  description:
    "Judges subscriptions by usage, not billing. Every rupee traces to a transaction.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-screen antialiased">
        <SiteHeader />
        {children}
        <ChatBubble />
      </body>
    </html>
  );
}
