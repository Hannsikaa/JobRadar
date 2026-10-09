"use client";

import { useEffect } from "react";

/**
 * Segment error boundary. `retry` re-fetches and re-renders the segment; it
 * replaced the older `reset`-only API and is the preferred recovery action in
 * Next.js 16.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">
        Something went wrong
      </h2>
      <p className="text-[15px] text-zinc-400">
        The page could not be rendered. Retrying usually clears a transient
        failure such as an unreachable database.
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-zinc-500">
          Reference: {error.digest}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => retry()}
        className="mt-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
      >
        Try again
      </button>
    </div>
  );
}