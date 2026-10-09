import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Not found",
};

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">404</p>
      <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">Page not found</h2>
      <p className="text-[15px] text-zinc-400">
        That URL does not match anything in Job Radar yet.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
      >
        Back to Workflow
      </Link>
    </div>
  );
}
