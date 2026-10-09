import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { getClientEnv } from "@/lib/env";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: getClientEnv().NEXT_PUBLIC_APP_NAME,
    template: `%s · ${getClientEnv().NEXT_PUBLIC_APP_NAME}`,
  },
  description:
    "Personalized job and internship discovery with transparent match reasons and freshness filtering.",
};

// Props are typed explicitly rather than with the generated `LayoutProps<"/">`
// global so `npm run typecheck` also passes on a clean checkout, before
// `next dev` or `next build` has written `.next/types`.
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*
        suppressHydrationWarning is scoped to this single element, not the app.
        The browser extension Grammarly injects `data-gr-ext-installed` and
        `data-new-gr-c-s-check-loaded` into <body> before React hydrates, so the
        live DOM legitimately differs from the server HTML we sent. React only
        suppresses attribute/text-mismatch warnings for the element it is set on,
        so genuine hydration bugs anywhere in the tree still warn. React strips
        this prop, so it never appears in the rendered markup.
      */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        <a
          href="#content"
          className="sr-only z-50 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main
          id="content"
          className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10"
        >
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}