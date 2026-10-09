import Link from "next/link";

import { NavLinks } from "@/components/nav-links";
import { getClientEnv } from "@/lib/env";

const NAV_ITEMS = [
  { href: "/workflow", label: "Workflow" },
  { href: "/resume", label: "Resume" },
  { href: "/profile-review", label: "Profile" },
  { href: "/settings", label: "Settings" },
] as const;

/**
 * Server-rendered shell header. The interactive part — knowing which route is
 * current — is delegated to the small `NavLinks` client component, so the brand
 * and layout stay on the server.
 */
export function SiteHeader() {
  const { NEXT_PUBLIC_APP_NAME } = getClientEnv();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--background)]/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Link
          href="/"
          className="group flex items-center gap-2 text-[15px] font-semibold tracking-tight text-zinc-100"
        >
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/30 transition-colors group-hover:bg-emerald-500/25"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <circle cx="12" cy="12" r="7.5" />
              <circle cx="12" cy="12" r="3" />
              <path strokeLinecap="round" d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
          </span>
          {NEXT_PUBLIC_APP_NAME}
        </Link>

        <NavLinks items={NAV_ITEMS} />
      </div>
    </header>
  );
}

/** Shell footer. Static, so it stays out of every page's render path. */
export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--border)]">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-1 px-4 py-5 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="text-zinc-400">
          Job Radar — resume in, ranked live jobs out.
        </p>
        <p className="font-mono text-[11px] tracking-wide text-zinc-600">
          Live results from Google Jobs via SerpApi
        </p>
      </div>
    </footer>
  );
}
