"use client";

import { useCallback, useRef, useState } from "react";

import { JobResults } from "@/components/job-results";
import type { DiscoveryReport, DiscoveryRunner } from "@/components/workflow";
import { WorkflowContent } from "@/components/workflow-content";
import { userFetch } from "@/lib/identity/demo-user";
import type { JobSearchResult } from "@/lib/jobs/types";

/**
 * The browser half of discovery: one request, three stage transitions.
 *
 * This component owns no scanning logic. It calls `GET /api/jobs/search`, reports
 * what happened to the three stages the pipeline owns, and renders whatever came
 * back. Everything about *what* a job is, and whether it matches, was decided
 * server-side by `@/lib/jobs/search` — so nothing here can invent a score, a
 * badge, or a job.
 *
 * The stage contract is respected exactly as `@/lib/workflow/state` defines it: a
 * stage goes to `processing` before its request starts and to `completed` or
 * `failed` when it settles. `serpapi` and `process` are set from the same
 * response rather than from timers, because both are decided inside that one
 * request and reporting them separately would mean claiming progress that had not
 * happened yet.
 *
 * Two runners, one set of facts: `runDiscovery` performs a real scan, while
 * `restoreDiscovery` redraws the last one that already happened — so a refresh
 * preserves the completed nodes and the jobs below them instead of resetting
 * state that genuinely exists.
 */

/** The response body, as far as this component trusts it. */
type SearchResponseBody = {
  jobs?: JobSearchResult["jobs"];
  metadata?: JobSearchResult["metadata"];
  attempts?: JobSearchResult["attempts"];
  error?: { code?: string; message?: string };
};

/** The response body of `GET /api/jobs/last`. */
type LastScanResponseBody = {
  /** `null` means "nothing to restore" — a normal answer, not an error. */
  result?: SearchResponseBody | null;
};

/**
 * Whether a body is usable as a result.
 *
 * Every field is checked rather than cast: this is untrusted JSON arriving over
 * the network, and rendering `{jobs: undefined}` as a list would produce an empty
 * state that looks like "no matches" after a successful scan.
 */
function isSearchResult(body: SearchResponseBody | null): body is {
  jobs: JobSearchResult["jobs"];
  metadata: JobSearchResult["metadata"];
  attempts: JobSearchResult["attempts"];
} {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray(body.jobs) &&
    typeof body.metadata === "object" &&
    body.metadata !== null &&
    Array.isArray(body.attempts)
  );
}

/** Reads the API's error envelope, falling back to a sentence of our own. */
function readErrorMessage(body: SearchResponseBody | null, fallback: string): string {
  if (typeof body?.error?.message === "string" && body.error.message.length > 0) {
    return body.error.message;
  }

  return fallback;
}

/**
 * Reports a completed scan's real counts onto the three discovery nodes.
 *
 * Shared by the run and the restore path so both describe the same scan the
 * same way: one scan described two different ways would read as two scans.
 */
function reportCompletedScan(
  report: DiscoveryReport,
  metadata: JobSearchResult["metadata"]
): void {
  // The technical counts (queries issued, raw entries, duplicates removed) are
  // deliberately absent here. They are real and still available, but they live
  // behind the results page's "Search details" disclosure rather than on the
  // pipeline nodes, where a person is reading for progress, not dumps. The nodes
  // say what happened in plain terms, and only speak up when part of the scan
  // actually failed.
  if (metadata.failedSearchCount > 0) {
    report.setStage("serpapi", "completed", {
      error: `${metadata.failedSearchCount} search(es) failed`,
    });
  } else {
    report.setStage("serpapi", "completed");
  }

  report.setStage("process", "completed");

  report.setStage("job-matches", "completed", {
    detail: `${metadata.total} match${metadata.total === 1 ? "" : "es"}`,
  });
}

export function JobDiscovery() {
  const [result, setResult] = useState<JobSearchResult | null>(null);

  /**
   * Whether a real scan has started in this page load.
   *
   * The restore path checks it before *and* after its fetch: a user who presses
   * Start while the restore is in flight gets the live scan's answer, and the
   * restore — older by construction — is dropped rather than overwriting a
   * fresher result with a staler one.
   */
  const scanStarted = useRef(false);

  const runDiscovery = useCallback<DiscoveryRunner>(
    async (report: DiscoveryReport) => {
      scanStarted.current = true;

      report.setStage("serpapi", "processing");
      // The request performs the search *and* the processing in one pass, so the
      // processing stage is marked as starting now rather than being left idle
      // while SerpApi is the only stage that appears to move.
      report.setStage("process", "processing");

      let body: SearchResponseBody | null = null;
      let response: Response;

      try {
        response = await userFetch("/api/jobs/search", { cache: "no-store" });
        body = (await response.json().catch(() => null)) as SearchResponseBody | null;
      } catch {
        const message = "Could not reach the server to run the job search.";

        report.setStage("serpapi", "failed", { error: message });
        report.setStage("process", "failed", { error: message });
        report.setStage("job-matches", "failed", { error: message });

        // A failed scan leaves the previous result in place rather than clearing
        // it: the jobs on screen were genuinely found, and blanking them would
        // hide real information because a later run failed.
        return;
      }

      if (!response.ok || !isSearchResult(body)) {
        const message = readErrorMessage(
          body,
          response.status === 404
            ? "No profile found. Upload a resume and review your profile first."
            : "The job search could not be completed."
        );

        report.setStage("serpapi", "failed", { error: message });
        report.setStage("process", "failed", { error: message });
        report.setStage("job-matches", "failed", { error: message });

        // Same reasoning as the network failure above.
        return;
      }

      reportCompletedScan(report, body.metadata);

      setResult({ jobs: body.jobs, metadata: body.metadata, attempts: body.attempts });
    },
    []
  );

  /**
   * Restores the last completed scan on mount, so a refresh does not destroy it.
   *
   * Best-effort by construction: every failure path — unreachable server, a
   * profile the server refuses to restore for, a body that does not shape-check —
   * reports nothing and leaves the nodes idle, because "there is nothing to
   * restore" and "restore failed" look identical to the user, and neither is a
   * failure of anything currently running. The server has already decided the
   * stored scan is still current (same resume, no profile edit since); this side
   * only decides whether it still applies to the page in front of the user.
   */
  const restoreDiscovery = useCallback<DiscoveryRunner>(
    async (report: DiscoveryReport) => {
      if (scanStarted.current) {
        return;
      }

      let body: LastScanResponseBody | null = null;

      try {
        const response = await userFetch("/api/jobs/last", { cache: "no-store" });

        if (!response.ok) {
          return;
        }

        body = (await response.json().catch(() => null)) as LastScanResponseBody | null;
      } catch {
        return;
      }

      const restored = body?.result ?? null;

      if (!isSearchResult(restored)) {
        return;
      }

      // Re-checked after the awaits: a run that started while this fetch was in
      // flight has already reported fresher stages, and the restore must not
      // stomp them with the previous page load's numbers.
      if (scanStarted.current) {
        return;
      }

      reportCompletedScan(report, restored.metadata);
      setResult({ jobs: restored.jobs, metadata: restored.metadata, attempts: restored.attempts });
    },
    []
  );

  return (
    <WorkflowContent
      onRunDiscovery={runDiscovery}
      onRestoreDiscovery={restoreDiscovery}
      onDiscoveryInvalidated={() => setResult(null)}
      {...(result === null ? {} : { results: <JobResults result={result} /> })}
    />
  );
}