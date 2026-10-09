"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary navigation.
 *
 * Kept as a small client component so the current route can be marked — the
 * header itself stays a server component. The active item is signalled three
 * ways at once (a filled surface, a brighter label, and `aria-current="page"`),
 * so it is obvious in a screenshot, in high-contrast mode, and to a screen
 * reader, rather than relying on colour alone.
 *
 * The list is a single non-wrapping row that scrolls sideways on very narrow
 * screens instead of wrapping to a ragged second line.
 */

export type NavItem = {
  href: string;
  label: string;
};

export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="-mx-1 overflow-x-auto">
      <ul className="flex w-max items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)]/70 p-1 text-sm">
        {items.map((item) => {
          const isActive =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={
                  isActive
                    ? "block whitespace-nowrap rounded-full bg-emerald-500/15 px-3.5 py-1.5 font-semibold text-emerald-300 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.35)]"
                    : "block whitespace-nowrap rounded-full px-3.5 py-1.5 font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
                }
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
