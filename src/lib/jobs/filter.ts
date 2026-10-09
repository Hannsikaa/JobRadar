import { annualize } from "@/lib/jobs/salary";
import { selectJobSource } from "@/lib/jobs/apply-source";
import type { JobSourceKind, NormalizedJob } from "@/lib/jobs/types";

/**
 * Client-side result controls: filtering and sorting a scan that is already on
 * screen.
 *
 * Everything here is pure and total. It never calls SerpApi, never rewrites a
 * job, and never changes the scan metadata — it only decides which of the jobs
 * the server already returned are shown, and in what order. That separation is
 * deliberate: changing a filter must be instant and free, and a fresh scan must
 * only ever happen because the user pressed Run Again.
 *
 * Two honesty rules run through the whole file:
 *
 * 1. **Unknown is not a value.** A job with no stated age, salary, or work mode
 *    is never treated as "0 days old", "unpaid", or "on-site". Filters that ask
 *    for a known quality exclude jobs whose quality is unknown rather than
 *    guessing on their behalf.
 * 2. **No salary is invented to sort by.** Salary sorting puts jobs with a
 *    readable figure first and jobs without one last; a missing salary never
 *    sorts as though it were zero.
 */

/** Application status, as kept per (user, job) by `applications.ts`. */
export type ApplicationStatusFilter = "all" | "not-applied" | "applied";

/** Posting window in whole days; `"all"` disables the filter. */
export type PostedFilter = "all" | 1 | 3 | 7 | 14;

/** Whether a listing must show a salary at all. */
export type SalaryFilter = "all" | "with" | "without";

/** Work arrangement, only counted when the listing stated it. */
export type WorkModeFilter = "all" | "remote" | "hybrid" | "onsite";

/** Minimum deterministic relevance score. */
export type MinScoreFilter = "all" | 80 | 70 | 60;

/**
 * Which destinations are trusted enough to show.
 *
 * `official` is the default because the product's promise is a verified
 * application, not a large count. `third-party` adds boards and publishers;
 * `all` also adds destinations we could not classify at all.
 */
export type SourceFilter = "official" | "third-party" | "all";

export type JobSort = "best" | "newest" | "salary";

export type JobFilters = {
  status: ApplicationStatusFilter;
  posted: PostedFilter;
  salary: SalaryFilter;
  workMode: WorkModeFilter;
  minScore: MinScoreFilter;
  source: SourceFilter;
};

export const DEFAULT_JOB_FILTERS: JobFilters = {
  status: "all",
  posted: "all",
  salary: "all",
  workMode: "all",
  minScore: "all",
  source: "official",
};

export const DEFAULT_JOB_SORT: JobSort = "best";

/** A fresh copy, so a component cannot mutate the shared default. */
export function defaultJobFilters(): JobFilters {
  return { ...DEFAULT_JOB_FILTERS };
}

/**
 * The work arrangement of a job, or `"unknown"`.
 *
 * Only a statement is trusted: `isRemote` when the listing set it, or the
 * location/schedule text when it plainly says so. An unlabelled "New York, NY"
 * is left `"unknown"` and excluded from every specific work-mode filter, rather
 * than being quietly classified as on-site.
 */
export function getWorkMode(job: NormalizedJob): WorkModeFilter | "unknown" {
  const text = `${job.location ?? ""} ${job.scheduleType ?? ""}`.toLowerCase();

  if (/\bhybrid\b/.test(text)) {
    return "hybrid";
  }

  if (
    job.isRemote === true ||
    /\bremote\b|\bwork from home\b|\bwfh\b|\banywhere\b|\btelecommut/.test(text)
  ) {
    return "remote";
  }

  if (job.isRemote === false) {
    return "onsite";
  }

  return "unknown";
}

/**
 * True when a destination kind passes the source preference.
 *
 * `third-party` deliberately still excludes `unverified`: a link we could not
 * classify is not the same as a link we know is a job board.
 */
export function sourceKindPassesFilter(kind: JobSourceKind, filter: SourceFilter): boolean {
  switch (filter) {
    case "official":
      return kind === "official_company_site" || kind === "verified_employer_ats";
    case "third-party":
      return kind !== "unverified";
    default:
      return true;
  }
}

/** The destination kind a job will be shown with, recomputed deterministically. */
export function jobSourceKind(job: NormalizedJob): JobSourceKind {
  return selectJobSource(job)?.kind ?? "unverified";
}

/**
 * The jobs the source preference keeps, before any other filter.
 *
 * Kept separate so the results header can report an honest count: with
 * `official` active, "N matching jobs" must not include the listings the
 * preference is hiding.
 */
export function filterJobsBySource(
  jobs: readonly NormalizedJob[],
  filter: SourceFilter
): NormalizedJob[] {
  return jobs.filter((job) => sourceKindPassesFilter(jobSourceKind(job), filter));
}

/**
 * Applies every active filter.
 *
 * `appliedIds` is the set of job ids the user has marked applied. It is passed in
 * rather than read here so the filter stays pure and testable without storage.
 */
export function filterJobs(
  jobs: readonly NormalizedJob[],
  filters: JobFilters,
  appliedIds: ReadonlySet<string> = new Set()
): NormalizedJob[] {
  return jobs.filter((job) => {
    if (!sourceKindPassesFilter(jobSourceKind(job), filters.source)) {
      return false;
    }

    if (filters.status === "applied" && !appliedIds.has(job.id)) {
      return false;
    }

    if (filters.status === "not-applied" && appliedIds.has(job.id)) {
      return false;
    }

    if (filters.posted !== "all") {
      // An unstated age cannot be shown to fall inside a window, so it is
      // excluded rather than assumed fresh.
      if (job.posted === undefined || job.posted.days > filters.posted) {
        return false;
      }
    }

    if (filters.salary === "with" && job.salary === undefined) {
      return false;
    }

    if (filters.salary === "without" && job.salary !== undefined) {
      return false;
    }

    if (filters.workMode !== "all" && getWorkMode(job) !== filters.workMode) {
      return false;
    }

    if (filters.minScore !== "all" && job.relevanceScore < filters.minScore) {
      return false;
    }

    return true;
  });
}

/**
 * How many filters are narrowing the list, for the "K filters active" label.
 *
 * The source preference is deliberately not counted: it is a standing choice
 * shown in its own control, not one of the narrowing filters the label reports.
 */
export function countActiveFilters(filters: JobFilters): number {
  let count = 0;

  if (filters.status !== "all") {
    count += 1;
  }

  if (filters.posted !== "all") {
    count += 1;
  }

  if (filters.salary !== "all") {
    count += 1;
  }

  if (filters.workMode !== "all") {
    count += 1;
  }

  if (filters.minScore !== "all") {
    count += 1;
  }

  return count;
}

/**
 * The number a salary sorts by: an annualized figure when the period is known,
 * otherwise the raw printed number, otherwise `null`.
 *
 * No currency conversion is performed — the rest of the app deliberately avoids
 * it — so a cross-currency ordering is approximate. It is only ever an ordering
 * the user explicitly asked for, and an unreadable salary sorts last rather than
 * as zero.
 */
export function salarySortValue(job: NormalizedJob): number | null {
  const salary = job.salary;

  if (salary === undefined) {
    return null;
  }

  const annual = annualize(salary);
  if (annual !== null) {
    return annual;
  }

  return salary.max ?? salary.min ?? null;
}

function comparePostedAsc(a: NormalizedJob, b: NormalizedJob): number {
  const aDays = a.posted?.days;
  const bDays = b.posted?.days;

  if (aDays === undefined && bDays === undefined) {
    return 0;
  }

  // Unknown age always sorts after a known age.
  if (aDays === undefined) {
    return 1;
  }

  if (bDays === undefined) {
    return -1;
  }

  return aDays - bDays;
}

function compareToStrings(a: NormalizedJob, b: NormalizedJob): number {
  return a.title.localeCompare(b.title);
}

function byBest(a: NormalizedJob, b: NormalizedJob): number {
  return (
    b.relevanceScore - a.relevanceScore ||
    comparePostedAsc(a, b) ||
    compareToStrings(a, b)
  );
}

function byNewest(a: NormalizedJob, b: NormalizedJob): number {
  return (
    comparePostedAsc(a, b) ||
    b.relevanceScore - a.relevanceScore ||
    compareToStrings(a, b)
  );
}

function bySalary(a: NormalizedJob, b: NormalizedJob): number {
  const aValue = salarySortValue(a);
  const bValue = salarySortValue(b);

  if (aValue === null && bValue === null) {
    return b.relevanceScore - a.relevanceScore || compareToStrings(a, b);
  }

  if (aValue === null) {
    return 1;
  }

  if (bValue === null) {
    return -1;
  }

  return bValue - aValue || b.relevanceScore - a.relevanceScore || compareToStrings(a, b);
}

/** Returns a new array; the input order is never mutated. */
export function sortJobs(jobs: readonly NormalizedJob[], sort: JobSort): NormalizedJob[] {
  const copy = [...jobs];

  switch (sort) {
    case "newest":
      return copy.sort(byNewest);
    case "salary":
      return copy.sort(bySalary);
    default:
      return copy.sort(byBest);
  }
}

/** A full pass: filter, then sort. The order the UI actually renders. */
export function applyJobControls(
  jobs: readonly NormalizedJob[],
  filters: JobFilters,
  sort: JobSort,
  appliedIds: ReadonlySet<string> = new Set()
): NormalizedJob[] {
  return sortJobs(filterJobs(jobs, filters, appliedIds), sort);
}

/** Selectable options, so the toolbar is data-driven rather than hard-coded. */
export const STATUS_FILTER_OPTIONS: readonly { value: ApplicationStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "not-applied", label: "Not applied" },
  { value: "applied", label: "Applied" },
];

export const POSTED_FILTER_OPTIONS: readonly { value: PostedFilter; label: string }[] = [
  { value: "all", label: "Any time" },
  { value: 1, label: "Today" },
  { value: 3, label: "Last 3 days" },
  { value: 7, label: "Last 7 days" },
  { value: 14, label: "Last 14 days" },
];

export const SALARY_FILTER_OPTIONS: readonly { value: SalaryFilter; label: string }[] = [
  { value: "all", label: "Any" },
  { value: "with", label: "With salary" },
  { value: "without", label: "Without salary" },
];

export const WORK_MODE_FILTER_OPTIONS: readonly { value: WorkModeFilter; label: string }[] = [
  { value: "all", label: "Any" },
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "On-site" },
];

export const MIN_SCORE_FILTER_OPTIONS: readonly { value: MinScoreFilter; label: string }[] = [
  { value: "all", label: "Any" },
  { value: 80, label: "80+" },
  { value: 70, label: "70+" },
  { value: 60, label: "60+" },
];

export const SOURCE_FILTER_OPTIONS: readonly { value: SourceFilter; label: string }[] = [
  { value: "official", label: "Official & verified" },
  { value: "third-party", label: "Include third-party" },
  { value: "all", label: "All sources" },
];

export const SORT_OPTIONS: readonly { value: JobSort; label: string }[] = [
  { value: "best", label: "Best Match" },
  { value: "newest", label: "Newest" },
  { value: "salary", label: "Highest Salary" },
];
