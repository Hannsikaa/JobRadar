"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { selectJobSource, type JobSourceKind } from "@/lib/jobs/apply-source";
import {
  MIN_SCORE_FILTER_OPTIONS,
  POSTED_FILTER_OPTIONS,
  SALARY_FILTER_OPTIONS,
  SORT_OPTIONS,
  SOURCE_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  WORK_MODE_FILTER_OPTIONS,
  applyJobControls,
  countActiveFilters,
  defaultJobFilters,
  filterJobsBySource,
  getWorkMode,
  type JobFilters,
  type JobSort,
} from "@/lib/jobs/filter";
import { formatPostedAgeShort } from "@/lib/jobs/freshness";
import type {
  DirectSourceReport,
  JobSearchMetadata,
  JobSearchResult,
  NormalizedJob,
  OfficialDiscoveryStatus,
} from "@/lib/jobs/types";
import { userFetch } from "@/lib/identity/demo-user";

/**
 * Job match cards — the payoff of the pipeline, and the only place in the app a
 * person acts on a result.
 *
 * Three product rules shape this file:
 *
 * 1. **The results are already ranked; the tools are for narrowing.** Filtering
 *    and sorting are pure client-side operations over the jobs the server
 *    returned. Changing one is instant, costs nothing, and never triggers a new
 *    SerpApi request — a new scan only ever happens because the user presses Run
 *    Again.
 * 2. **Unknown is never a value.** A missing salary is "Salary not listed", a
 *    missing age is "Age not stated", an unstated work arrangement is simply
 *    absent. The filters follow the same rule and exclude unknown data rather
 *    than guessing it.
 * 3. **The card's job is to get the user to a real application.** The primary
 *    button reads "Apply" only when the destination is the employer's own page,
 *    a verified employer ATS, or a third-party the user chose to include (see
 *    `apply-source.ts`); an unclassified destination is offered as "View original
 *    listing" instead. The source is stated with a trust badge, and no URL is
 *    ever invented. "Applied" is a mark the user sets, saved per user and
 *    restored on refresh — it is never inferred.
 *
 * The technical counts the scan produces (raw entries, duplicates, failed
 * queries, unknown ages) are all still present and truthful, but they live
 * behind the "Search details" disclosure instead of competing with the jobs.
 */

export type JobResultsProps = {
  result: JobSearchResult;
};

/** The body of `GET/POST /api/jobs/applications`, as far as we trust it. */
type ApplicationsBody = {
  applied?: unknown;
  available?: unknown;
};

export function JobResults({ result }: JobResultsProps) {
  const { jobs, metadata } = result;
  const failedAttempts = result.attempts.filter((attempt) => !attempt.ok);

  const [filters, setFilters] = useState<JobFilters>(defaultJobFilters);
  const [sort, setSort] = useState<JobSort>("best");
  const [appliedIds, setAppliedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [appliedError, setAppliedError] = useState<string | null>(null);

  // Reads the user's applied marks once, on mount. A failure leaves the set
  // empty and is not surfaced as a page error: a result list must render even if
  // the tiny status store is down.
  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const response = await userFetch("/api/jobs/applications", { cache: "no-store" });

        if (!active || !response.ok) {
          return;
        }

        const body = (await response.json().catch(() => null)) as ApplicationsBody | null;
        const applied = Array.isArray(body?.applied)
          ? body.applied.filter((id): id is string => typeof id === "string")
          : [];

        if (active) {
          setAppliedIds(new Set(applied));
        }
      } catch {
        // Status is best-effort; nothing to do.
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const setFilter = useCallback(<K extends keyof JobFilters>(key: K, value: JobFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(defaultJobFilters());
  }, []);

  /**
   * Marks or unmarks a job, optimistically.
   *
   * The mark is applied locally first so the button responds instantly, then
   * reverted if the write did not land. That ordering is what keeps the button
   * from ever showing "Applied" for a fact the server does not hold.
   */
  const toggleApplied = useCallback(
    async (jobId: string) => {
      const wasApplied = appliedIds.has(jobId);
      const next = !wasApplied;

      setAppliedError(null);
      setAppliedIds((previous) => {
        const copy = new Set(previous);
        if (next) {
          copy.add(jobId);
        } else {
          copy.delete(jobId);
        }
        return copy;
      });

      try {
        const response = await userFetch("/api/jobs/applications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, applied: next }),
        });

        if (!response.ok) {
          throw new Error("save failed");
        }
      } catch {
        setAppliedIds((previous) => {
          const copy = new Set(previous);
          if (wasApplied) {
            copy.add(jobId);
          } else {
            copy.delete(jobId);
          }
          return copy;
        });
        setAppliedError(
          next
            ? "Could not save that you applied. Check your connection and try again."
            : "Could not clear the applied mark. Check your connection and try again."
        );
      }
    },
    [appliedIds]
  );

  const visible = useMemo(
    () => applyJobControls(jobs, filters, sort, appliedIds),
    [appliedIds, filters, jobs, sort]
  );

  // The count the header reports is the source preference's result, before the
  // narrowing filters — otherwise "N matching jobs" would count listings the
  // source preference is hiding.
  const sourceScopedCount = useMemo(
    () => filterJobsBySource(jobs, filters.source).length,
    [filters.source, jobs]
  );

  const activeFilters = countActiveFilters(filters);

  return (
    <div className="flex flex-col gap-4">
      <ResultsToolbar
        total={sourceScopedCount}
        visibleCount={visible.length}
        activeFilters={activeFilters}
        filters={filters}
        sort={sort}
        newCount={metadata.newTrackingAvailable ? metadata.newCount : 0}
        onFilterChange={setFilter}
        onSortChange={setSort}
        onClear={clearFilters}
      />

      {appliedError !== null ? (
        <p role="status" className="text-[13px] text-amber-300">
          {appliedError}
        </p>
      ) : null}

      {failedAttempts.length > 0 ? <PartialScanWarning failedAttempts={failedAttempts} /> : null}

      {jobs.length === 0 ? (
        <EmptyState metadata={metadata} />
      ) : sourceScopedCount === 0 ? (
        <SourceEmptyState
          hiddenCount={jobs.length}
          onIncludeThirdParty={() => setFilter("source", "third-party")}
        />
      ) : visible.length === 0 ? (
        <FilteredEmptyState total={sourceScopedCount} onClear={clearFilters} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {visible.map((job) => (
            <li key={job.id} className="flex min-w-0">
              <JobCard
                job={job}
                applied={appliedIds.has(job.id)}
                onToggleApplied={(jobId) => void toggleApplied(jobId)}
              />
            </li>
          ))}
        </ul>
      )}

      <SearchDetails metadata={metadata} />
    </div>
  );
}

/**
 * Count, sort, and filters.
 *
 * Application status and sort sit directly beside the count because they are the
 * two controls most people reach for; the rest live behind a native
 * `<details>` panel, which is keyboard- and screen-reader-accessible without any
 * JavaScript of its own.
 */
function ResultsToolbar({
  total,
  visibleCount,
  activeFilters,
  filters,
  sort,
  newCount,
  onFilterChange,
  onSortChange,
  onClear,
}: {
  total: number;
  visibleCount: number;
  activeFilters: number;
  filters: JobFilters;
  sort: JobSort;
  newCount: number;
  onFilterChange: <K extends keyof JobFilters>(key: K, value: JobFilters[K]) => void;
  onSortChange: (sort: JobSort) => void;
  onClear: () => void;
}) {
  const filtering = activeFilters > 0;
  const noun = total === 1 ? "job" : "jobs";

  const countLine = filtering
    ? `${visibleCount} of ${total} matching ${noun}`
    : `${total} matching ${noun}`;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-xl font-semibold tracking-tight text-zinc-50">{countLine}</h3>

          {newCount > 0 ? (
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[12px] font-semibold text-emerald-300">
              {newCount} new
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            id="jr-source"
            label="Sources"
            value={filters.source}
            options={SOURCE_FILTER_OPTIONS}
            onChange={(value) => onFilterChange("source", value)}
          />
          <FilterSelect
            id="jr-sort"
            label="Sort"
            value={sort}
            options={SORT_OPTIONS}
            onChange={onSortChange}
          />
          <FilterSelect
            id="jr-status"
            label="Status"
            value={filters.status}
            options={STATUS_FILTER_OPTIONS}
            onChange={(value) => onFilterChange("status", value)}
          />
        </div>
      </div>

      <details className="group rounded-xl border border-[var(--border)] bg-black/20">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium text-zinc-300 marker:content-none hover:text-zinc-100">
          <span
            aria-hidden="true"
            className="text-zinc-500 transition-transform group-open:rotate-90"
          >
            ▸
          </span>
          Filters
          {activeFilters > 0 ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[12px] font-semibold text-emerald-300">
              {activeFilters} active
            </span>
          ) : (
            <span className="text-[12px] text-zinc-500">none</span>
          )}
        </summary>

        <div className="flex flex-col gap-3 border-t border-[var(--border)] px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect
              id="jr-status-panel"
              label="Application"
              value={filters.status}
              options={STATUS_FILTER_OPTIONS}
              onChange={(value) => onFilterChange("status", value)}
            />
            <FilterSelect
              id="jr-posted"
              label="Posted"
              value={filters.posted}
              options={POSTED_FILTER_OPTIONS}
              onChange={(value) => onFilterChange("posted", value)}
            />
            <FilterSelect
              id="jr-salary"
              label="Salary"
              value={filters.salary}
              options={SALARY_FILTER_OPTIONS}
              onChange={(value) => onFilterChange("salary", value)}
            />
            <FilterSelect
              id="jr-workmode"
              label="Work mode"
              value={filters.workMode}
              options={WORK_MODE_FILTER_OPTIONS}
              onChange={(value) => onFilterChange("workMode", value)}
            />
            <FilterSelect
              id="jr-score"
              label="Match score"
              value={filters.minScore}
              options={MIN_SCORE_FILTER_OPTIONS}
              onChange={(value) => onFilterChange("minScore", value)}
            />
          </div>

          {filtering ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClear}
                className="rounded-full border border-[var(--border-strong)] px-3 py-1.5 text-[13px] font-medium text-zinc-200 transition-colors hover:bg-white/5"
              >
                Clear filters
              </button>
              <span className="text-[13px] text-zinc-500">
                {activeFilters} filter{activeFilters === 1 ? "" : "s"} active
              </span>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

/** A labelled `<select>`. Native, so keyboard and screen-reader support is free. */
function FilterSelect<T extends string | number>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-[13px] font-medium text-zinc-400">
        {label}
      </label>
      <select
        id={id}
        value={String(value)}
        onChange={(event) => {
          const next = options.find((option) => String(option.value) === event.target.value);
          if (next !== undefined) {
            onChange(next.value);
          }
        }}
        className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[13px] text-zinc-100 transition-colors hover:border-[var(--border-strong)] focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Plain-language outcome of one employer-board query.
 *
 * The coverage disclosure lists every board the scan actually asked, including
 * the ones that failed, so a board being down reads as "unreachable" rather than
 * silently shrinking the result.
 */
const DIRECT_BOARD_STATUS_TEXT: Record<DirectSourceReport["status"], string> = {
  ok: "checked",
  empty: "no open roles",
  not_found: "board not found",
  rate_limited: "rate-limited",
  unavailable: "unreachable",
  malformed: "unreadable response",
};

/** The technical scan counts, collapsed by default. */
function SearchDetails({ metadata }: { metadata: JobSearchMetadata }) {
  const boards = metadata.directSources ?? [];

  return (
    <details className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40">
      <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium text-zinc-400 marker:content-none hover:text-zinc-200">
        Search details
      </summary>

      <div className="flex flex-col gap-3 border-t border-[var(--border)] px-4 py-3">
        <p className="text-[13px] leading-relaxed text-zinc-400">{describeScan(metadata)}</p>

        <ul className="flex flex-wrap gap-2">
          {scanStats(metadata).map((stat) => (
            <li
              key={stat}
              className="rounded-full border border-[var(--border)] bg-black/20 px-2.5 py-1 text-[12px] text-zinc-400"
            >
              {stat}
            </li>
          ))}
        </ul>

        {boards.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-zinc-500">
              Employer boards checked
            </p>
            <ul className="flex flex-col gap-0.5">
              {boards.map((board) => (
                <li
                  key={`${board.platform}:${board.tenant}`}
                  className="text-[13px] text-zinc-400"
                >
                  {board.employer} · {board.platform} · {DIRECT_BOARD_STATUS_TEXT[board.status]}
                  {board.status === "ok"
                    ? ` · ${board.returned} open, ${board.matched} matched your roles`
                    : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** A partial scan, stated plainly above the results it affects. */
function PartialScanWarning({ failedAttempts }: { failedAttempts: JobSearchResult["attempts"] }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-red-500/30 bg-red-500/[0.06] px-3 py-2">
      <p className="text-[13px] font-medium text-red-300">
        {failedAttempts.length} search{failedAttempts.length === 1 ? "" : "es"} could not be
        completed — the results below are from the rest.
      </p>
      <ul className="flex flex-col gap-0.5">
        {failedAttempts.map((attempt) => (
          <li
            key={`${attempt.query}|${attempt.location ?? ""}`}
            className="text-[13px] text-red-300/90"
          >
            {attempt.role ?? attempt.query}
            {attempt.location ? ` · ${attempt.location}` : ""}: {attempt.error}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The summary sentence. Composed from the counts rather than hard-coded, so a
 * scan with unusual numbers still reads correctly.
 */
function describeScan(metadata: JobSearchMetadata): string {
  if (metadata.total === 0) {
    return describeEmptyResult(metadata);
  }

  const sentences: string[] = [
    "Ranked by how well each listing fits your profile, with the reason shown on every card.",
  ];

  if (metadata.newTrackingAvailable) {
    sentences.push(
      metadata.newCount > 0
        ? `${metadata.newCount} appeared since your last scan.`
        : "None are new since your last scan."
    );
  }

  if (metadata.failedSearchCount > 0) {
    sentences.push("Some searches failed, so this may be partial.");
  }

  return sentences.join(" ");
}

/** The supporting counts, each one a real measurement. */
function scanStats(metadata: JobSearchMetadata): string[] {
  const stats: string[] = [
    `${metadata.freshCount} within ${metadata.freshnessDays}d`,
    `${metadata.salaryKnownCount}/${metadata.total} with salary`,
  ];

  if (metadata.duplicateCount > 0) {
    stats.push(`${metadata.duplicateCount} duplicate${metadata.duplicateCount === 1 ? "" : "s"} removed`);
  }

  if (metadata.belowMinimumCount > 0) {
    stats.push(`${metadata.belowMinimumCount} below your salary floor`);
  }

  if (metadata.unknownAgeCount > 0) {
    stats.push(`${metadata.unknownAgeCount} with no stated age`);
  }

  stats.push(`${metadata.searchCount - metadata.failedSearchCount}/${metadata.searchCount} searches`);

  if ((metadata.directSourceBoards ?? 0) > 0) {
    stats.push(
      `${metadata.directSourceBoards} employer board${metadata.directSourceBoards === 1 ? "" : "s"} checked`
    );
  }

  if (!metadata.newTrackingAvailable) {
    // Says why NEW is missing rather than letting an empty badge read as a fact.
    stats.push("new-job history unavailable");
  }

  return stats;
}

/** An honest sentence for a scan that completed and matched nothing. */
function describeEmptyResult(metadata: JobSearchMetadata): string {
  if (metadata.failedSearchCount > 0) {
    return "No jobs came back from the searches that succeeded. The failed searches are listed above.";
  }

  if (metadata.total === 0 && metadata.rawCount > 0) {
    return "Google returned results, but none were inside your filters.";
  }

  if (metadata.rawCount === 0) {
    return "Google Jobs returned no results for this search.";
  }

  return "No jobs matched this scan.";
}

/** No jobs from the scan at all — distinct from "filters hide everything". */
function EmptyState({ metadata }: { metadata: JobSearchMetadata }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 px-6 py-14 text-center">
      <span
        aria-hidden="true"
        className="grid size-11 place-items-center rounded-full border border-[var(--border)] bg-black/20 text-zinc-500"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path strokeLinecap="round" d="m20 20-4.7-4.7" />
        </svg>
      </span>
      <p className="max-w-md text-sm text-zinc-300">{describeEmptyResult(metadata)}</p>
      <p className="max-w-md text-[13px] text-zinc-500">
        Try widening your freshness window, adding locations, or adjusting target roles in Profile
        Review.
      </p>
    </div>
  );
}

/** Jobs were found, but the active filters exclude all of them. */
function FilteredEmptyState({ total, onClear }: { total: number; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 px-6 py-12 text-center">
      <p className="text-sm text-zinc-300">No jobs match the current filters.</p>
      <p className="max-w-md text-[13px] text-zinc-500">
        {total} matching {total === 1 ? "job was" : "jobs were"} found, but the active filters hide
        them all.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="rounded-full border border-[var(--border-strong)] px-4 py-2 text-[13px] font-medium text-zinc-100 transition-colors hover:bg-white/5"
      >
        Clear filters
      </button>
    </div>
  );
}

/**
 * Jobs were found, but none had an official or verified-employer destination.
 *
 * This is the honest version of "no results": the listings exist, they just do
 * not clear the trust bar the source preference sets. The wording says exactly
 * that and offers the one action that would change it.
 */
function SourceEmptyState({
  hiddenCount,
  onIncludeThirdParty,
}: {
  hiddenCount: number;
  onIncludeThirdParty: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 px-6 py-12 text-center">
      <p className="text-sm text-zinc-300">
        No verified employer-hosted listings were found for this search.
      </p>
      <p className="max-w-md text-[13px] text-zinc-500">
        {hiddenCount} {hiddenCount === 1 ? "listing was" : "listings were"} found, but none on the
        employer&apos;s own site or a verified employer ATS. Try including third-party sources to
        broaden your results.
      </p>
      <button
        type="button"
        onClick={onIncludeThirdParty}
        className="rounded-full border border-[var(--border-strong)] px-4 py-2 text-[13px] font-medium text-zinc-100 transition-colors hover:bg-white/5"
      >
        Include third-party listings
      </button>
    </div>
  );
}

/** Score colour. Always paired with the number and the word "Match". */
function scoreTone(score: number): { stroke: string; text: string } {
  if (score >= 70) {
    return { stroke: "#34d399", text: "text-emerald-300" };
  }

  if (score >= 45) {
    return { stroke: "#fbbf24", text: "text-amber-300" };
  }

  return { stroke: "#a1a1aa", text: "text-zinc-300" };
}

function MatchBadge({ score }: { score: number }) {
  const tone = scoreTone(score);
  const clamped = Math.max(0, Math.min(100, score));
  // Circumference of r=15.5 is ~97.39; the dash offset draws the filled arc.
  const circumference = 2 * Math.PI * 15.5;
  const dash = (clamped / 100) * circumference;

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div className="relative grid size-14 place-items-center">
        <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
          <circle
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            stroke={tone.stroke}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
          />
        </svg>
        <span
          className={`text-xl font-semibold tabular-nums ${tone.text}`}
          title={`Relevance score: ${score} of 100`}
        >
          {score}
        </span>
      </div>
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        Match
      </span>
    </div>
  );
}

/** Tone per trust tier. Never colour alone — the badge always carries the words. */
const SOURCE_TONE: Record<JobSourceKind, string> = {
  official_company_site: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  verified_employer_ats: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  third_party: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  unverified: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
};

/** The trust classification of the apply destination: a worded, truthful badge. */
function SourceBadge({ kind, label }: { kind: JobSourceKind; label: string }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] ${SOURCE_TONE[kind]}`}
    >
      {label}
    </span>
  );
}

/**
 * Plain-language outcome of the official-careers check.
 *
 * Every value is a fact about what was found, including the "no" answers. None
 * of them implies the listing is fake — an unverifiable listing is still shown.
 */
const DISCOVERY_STATUS_TEXT: Record<OfficialDiscoveryStatus, string> = {
  verified_official_job: "Found this role on the employer's own site.",
  verified_employer_ats_job: "Found this role on the employer's verified ATS board.",
  employer_found_no_job: "Found the employer's site, but no posting matching this role.",
  employer_mismatch: "A matching ATS posting belongs to a different employer.",
  role_mismatch: "Found a page for the employer, but for a different role.",
  location_mismatch: "Found a page for this role, but in a different location.",
  no_employer_domain: "No official employer page could be identified.",
  provider_error: "The official-careers check could not be completed.",
};

/** A short, locale-independent date for "last checked". */
function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function JobCard({
  job,
  applied,
  onToggleApplied,
}: {
  job: NormalizedJob;
  applied: boolean;
  onToggleApplied: (jobId: string) => void;
}) {
  const posted = formatPostedAgeShort(job.posted ?? null);
  const source = selectJobSource(job);
  const workMode = getWorkMode(job);

  // Only a destination the evidence supports gets an "Apply" call to action.
  // A third-party listing gets an honest "View listing"; anything we could not
  // classify is offered only as the original listing, never as an application.
  const verified = source !== null && source.official;
  const thirdParty = source !== null && source.kind === "third_party";

  const ctaLabel = verified ? "Apply" : thirdParty ? "View listing" : "View original listing";

  const destinationProvider = source?.provider ?? source?.publisher ?? null;
  const discovery = job.officialDiscovery;
  const sourceReasons = source?.evidence ?? [];

  const workModeLabel =
    workMode === "remote"
      ? "Remote"
      : workMode === "hybrid"
        ? "Hybrid"
        : workMode === "onsite"
          ? "On-site"
          : null;

  const meta = [job.location, workModeLabel].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );

  return (
    <article className="group jr-rise flex h-full w-full flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-4 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)] sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[19px] font-semibold leading-snug text-zinc-50">{job.title}</h3>
          <p className="truncate text-[15px] text-zinc-300">
            {job.company ?? "Employer not stated"}
          </p>
        </div>

        <MatchBadge score={job.relevanceScore} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-zinc-400">
        {meta.length > 0 ? <span className="text-zinc-300">{meta.join(" · ")}</span> : null}

        <span className="text-zinc-500">
          {posted === undefined ? "Age not stated" : `Posted ${posted}`}
        </span>

        <span className={job.salary === undefined ? "text-zinc-500" : "text-zinc-300"}>
          {job.salary?.text ?? "Salary not listed"}
        </span>

        {job.isNew ? (
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-emerald-300">
            New
          </span>
        ) : null}
      </div>

      {job.relevanceReasons.length > 0 ? (
        <ReasonChips reasons={job.relevanceReasons} />
      ) : (
        // No reasons means no signal fired. Saying so is better than an empty row
        // that reads as a rendering bug.
        <p className="text-[13px] text-zinc-500">No match signals found in the listing.</p>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--border)] pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {source !== null ? <SourceBadge kind={source.kind} label={source.label} /> : null}
          <span className="min-w-0 truncate text-[13px] text-zinc-500">
            {source === null
              ? "No apply link on this listing"
              : destinationProvider === null
                ? "Link on this listing"
                : `via ${destinationProvider}`}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-pressed={applied}
            onClick={() => onToggleApplied(job.id)}
            className={[
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
              applied
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
                : "border-[var(--border)] text-zinc-300 hover:border-[var(--border-strong)] hover:text-zinc-100",
            ].join(" ")}
          >
            {applied ? (
              <>
                <span aria-hidden="true">✓</span> Applied
              </>
            ) : (
              "Mark applied"
            )}
          </button>

          {source !== null ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={
                verified
                  ? `Apply to ${job.title}`
                  : thirdParty
                    ? `View the listing for ${job.title}`
                    : `View the original listing for ${job.title}`
              }
              className={
                verified
                  ? "inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
                  : "inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60"
              }
            >
              {ctaLabel}
              <span aria-hidden="true">↗</span>
            </a>
          ) : null}

          {source !== null && (sourceReasons.length > 0 || discovery !== undefined) ? (
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-full border border-[var(--border)] px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-[var(--border-strong)] hover:text-zinc-200">
                Why this source?
              </summary>
              <div className="absolute right-0 z-10 mt-2 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-3 text-left text-xs text-zinc-300 shadow-xl">
                <ul className="space-y-1">
                  {sourceReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                  {discovery !== undefined ? (
                    <li className="text-zinc-400">
                      {DISCOVERY_STATUS_TEXT[discovery.status]}
                      {" · checked "}
                      {shortDate(discovery.resolvedAt)}
                    </li>
                  ) : null}
                </ul>
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** The match reasons, capped with a "+N more" so a card stays scannable. */
function ReasonChips({ reasons }: { reasons: readonly string[] }) {
  const MAX = 3;
  const shown = reasons.slice(0, MAX);
  const extra = reasons.length - shown.length;

  return (
    <ul className="flex flex-wrap gap-1.5">
      {shown.map((reason) => (
        <li
          key={reason}
          className="rounded-full border border-[var(--border)] bg-white/[0.04] px-2.5 py-1 text-[12px] text-zinc-300"
        >
          {reason}
        </li>
      ))}
      {extra > 0 ? (
        <li className="rounded-full border border-transparent px-2.5 py-1 text-[12px] text-zinc-500">
          +{extra} more
        </li>
      ) : null}
    </ul>
  );
}
