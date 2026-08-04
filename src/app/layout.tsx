import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zombie — subscriptions you pay for but don't use",
  description:
    "Judges subscriptions by usage, not billing. Every rupee traces to a transaction.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
