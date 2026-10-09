"use client";

import {
  Workflow,
  type DiscoveryRunner,
} from "@/components/workflow";

/**
 * The workflow page composition: a compact product header, the six-node
 * workflow, and the results section.
 *
 * The long explanation now lives on the landing page; this screen is the tool.
 * The header says what the screen does in one line and then gets out of the way,
 * so the pipeline and the matches — not a wall of marketing — are what fill the
 * viewport. It is deliberately not a hero.
 */

export type WorkflowContentProps = {
  /** Wired to the SerpApi pipeline once it exists. */
  onRunDiscovery?: DiscoveryRunner;
  /** Runs on mount so a refresh restores the previous run's stages. */
  onRestoreDiscovery?: DiscoveryRunner;
  /** Called when a replaced resume invalidates the pipeline tail. */
  onDiscoveryInvalidated?: () => void;
  /** Rendered by the job-search implementation. */
  results?: React.ReactNode;
};

export function WorkflowContent({
  onRunDiscovery,
  onRestoreDiscovery,
  onDiscoveryInvalidated,
  results,
}: WorkflowContentProps) {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-400">
          Workflow
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">
          Run your job search
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-zinc-400">
          Upload a resume, confirm the profile it builds, then search live Google Jobs and rank
          the matches against what you have.
        </p>
      </header>

      <Workflow
        {...(onRunDiscovery === undefined ? {} : { onRunDiscovery })}
        {...(onRestoreDiscovery === undefined ? {} : { onRestoreDiscovery })}
        {...(onDiscoveryInvalidated === undefined ? {} : { onDiscoveryInvalidated })}
      />

      <section
        aria-labelledby="job-matches-heading"
        className="flex flex-col gap-4 border-t border-[var(--border)] pt-8"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="job-matches-heading"
            className="text-2xl font-semibold tracking-tight text-zinc-50"
          >
            Job Matches
          </h2>
          <p className="text-sm text-zinc-400">
            Every listing is scored against your profile, with the reason it matched.
          </p>
        </div>

        {results ?? (
          <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 px-6 py-12 text-center">
            <p className="text-sm text-zinc-400">
              Matches appear here once the pipeline runs.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
