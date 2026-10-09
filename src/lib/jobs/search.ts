import { getProfileByUserId } from "@/lib/profile/repository";
import type { StoredProfile } from "@/lib/profile/types";
import { selectJobSource } from "@/lib/jobs/apply-source";
import { markJobsSeen, recordScan } from "@/lib/jobs/discovery";
import { dedupeJobs } from "@/lib/jobs/dedupe";
import {
  buildDirectSourceRunner,
  type DirectSourceRunner,
} from "@/lib/jobs/direct-sources";
import { JobSearchError } from "@/lib/jobs/errors";
import { isWithinFreshnessWindow } from "@/lib/jobs/freshness";
import { scoreJobs } from "@/lib/jobs/matching";
import { normalizeJobs } from "@/lib/jobs/normalize";
import {
  attachOfficialDestinations,
  buildOfficialDiscoveryRunner,
  type OfficialDiscoveryRunner,
} from "@/lib/jobs/official-discovery";
import { buildSearchPlan, type PlannedSearch } from "@/lib/jobs/plan";
import { salaryMeetsMinimum, DEFAULT_FLOOR_PERIOD } from "@/lib/jobs/salary";
import { resolveSearchLocale, toProviderLocation } from "@/lib/serpapi/locale";
import {
  MAX_PAGES_PER_SEARCH,
  searchGoogleJobsPages,
  SerpApiError,
  type SerpApiJobResult,
} from "@/lib/serpapi/client";
import type {
  DirectSourceReport,
  ExperienceLevel,
  JobSearchMetadata,
  JobSearchResult,
  NormalizedJob,
  SearchAttempt,
} from "@/lib/jobs/types";

/**
 * The discovery orchestrator: profile in, ranked jobs out.
 *
 * This is the only place that knows the order of the pipeline. Each step is a
 * small pure module with its own tests, and this file's whole job is to run them
 * in the right order and to decide what a partial failure means.
 *
 *   profile → plan → SerpApi → normalize → dedupe → freshness → salary → score
 *          → mark seen → response
 *
 * Three rules govern what happens when a step fails:
 *
 * 1. **One bad query does not fail the scan.** Queries are independent; a failed
 *    one is recorded in `attempts` and the rest still produce results.
 * 2. **A partial result is a success.** `jobs` may be non-empty while
 *    `metadata.failedSearchCount` is non-zero, and the UI shows both.
 * 3. **Zero results is not an error.** A completed scan that found nothing is a
 *    completed scan. Only a scan that never reached SerpApi is an error.
 */

/** Injected so the orchestrator stays testable and callers control the clock. */
export type SearchJobsOptions = {
  /** Defaults to now. */
  now?: Date;
  /**
   * Replaces the SerpApi call. Exists so the pipeline can be tested end to end
   * without a network, and so a future provider could be swapped in.
   */
  fetchJobs?: (search: PlannedSearch) => Promise<{ jobs: SerpApiJobResult[]; pagesFetched: number }>;
  /**
   * Replaces official-careers discovery for this scan. `null` disables the
   * stage; `undefined` uses the configured default (on when a SerpApi key is
   * present and `OFFICIAL_DISCOVERY_MAX_TARGETS` is not zero). Injected so tests
   * never reach the network or MongoDB.
   */
  officialDiscovery?: OfficialDiscoveryRunner | null;
  /**
   * Replaces employer-board discovery for this scan. `null` disables the stage;
   * `undefined` uses the configured default (on unless
   * `DIRECT_SOURCE_MAX_TARGETS` is `0`). Injected so tests never reach a network.
   */
  directSources?: DirectSourceRunner | null;
};

/**
 * Attaches the verified apply source to a job.
 *
 * The classification is a pure function of the job's own links and employer, so
 * storing the result is retention rather than a second source of truth: the UI
 * can recompute it for scans recorded before this field existed.
 */
function withSourceEvidence(job: NormalizedJob): NormalizedJob {
  const source = selectJobSource(job);

  if (source === null) {
    return job;
  }

  return {
    ...job,
    selectedApplyUrl: source.url,
    applySourceKind: source.kind,
    applySourceLabel: source.label,
    applySourceVerified: source.official,
    applySourceEvidence: source.evidence,
  };
}

/**
 * Runs a full discovery scan for a user.
 *
 * Throws {@link JobSearchError} only when the scan could not be attempted or
 * could not produce a trustworthy answer at all: no profile, no target roles, no
 * locations, no SerpApi key, or every single query failing.
 */
export async function searchJobsForUser(
  userId: string,
  options: SearchJobsOptions = {}
): Promise<JobSearchResult> {
  const now = options.now ?? new Date();
  const profile = await loadProfile(userId);
  const preferences = profile.preferences;

  const roles = cleanList(preferences.targetRoles);
  if (roles.length === 0) {
    throw new JobSearchError(
      "target_roles_missing",
      "Choose at least one target role on your profile before running a search."
    );
  }

  const locations = cleanList(preferences.locations);
  if (locations.length === 0) {
    throw new JobSearchError(
      "locations_missing",
      "Choose at least one location on your profile before running a search."
    );
  }

  const plan = buildSearchPlan({
    targetRoles: roles,
    locations,
    experienceLevel: preferences.experienceLevel,
    jobTypes: preferences.jobTypes,
    remoteOnly: preferences.remoteOnly,
  });

  // `buildSearchPlan` only returns an empty plan when a list was empty, which is
  // already handled above. This is a guard against a future edit to the planner
  // silently producing a scan that reports "0 jobs found" without searching.
  if (plan.searches.length === 0) {
    throw new JobSearchError(
      "target_roles_missing",
      "The search plan came out empty. Check your target roles and locations."
    );
  }

  const fetchJobs = options.fetchJobs ?? defaultFetcher;
  const outcomes = await Promise.all(plan.searches.map((search) => runSearch(search, fetchJobs)));

  const attempts = outcomes.map((outcome) => outcome.attempt);
  const failed = attempts.filter((attempt) => !attempt.ok);

  // Every query failed: there is no partial answer to report, and a scan that
  // never reached the provider should not look like "no jobs matched".
  if (failed.length === attempts.length) {
    throw toSearchError(failed);
  }

  const rawCount = outcomes.reduce((total, outcome) => total + outcome.raw.length, 0);

  // Normalization happens per query so each job is labelled with the role and
  // location that actually surfaced it. Normalizing once at the end would leave
  // that mapping to be reconstructed by position, which is exactly the kind of
  // thing that silently mislabels cards after a change upstream.
  const tagged = outcomes.flatMap((outcome) =>
    normalizeJobs(outcome.raw).map((job) => ({
      ...job,
      ...(outcome.attempt.role === undefined ? {} : { matchedRole: outcome.attempt.role }),
      ...(outcome.attempt.location === undefined
        ? {}
        : { searchedLocation: outcome.attempt.location }),
    }))
  );

  const { jobs: deduped, removed: searchDuplicateCount } = dedupeJobs(tagged);

  // Employer-board discovery. Board postings are ordinary normalized jobs, so
  // they merge in before freshness, salary, and scoring, and are re-deduplicated
  // against the search results — a job that both the search and the board carried
  // stays one card. The stage is an enrichment: any failure leaves the search
  // jobs untouched (see enrichWithDirectSources).
  const direct = await enrichWithDirectSources(
    deduped,
    roles,
    resolveDirectSourceRunner(options.directSources),
    now
  );

  const { jobs: combined, removed: directDuplicateCount } = dedupeJobs([
    ...deduped,
    ...direct.jobs,
  ]);
  const duplicateCount = searchDuplicateCount + directDuplicateCount;

  // Retention, not labelling: unknown-date jobs stay (isWithinFreshnessWindow)
  // but are never marked fresh (isFreshForWindow, applied in scoreJobs).
  const fresh = combined.filter((job) =>
    isWithinFreshnessWindow(job.posted ?? null, preferences.freshnessDays)
  );

  const floor =
    preferences.minimumSalary === undefined || (preferences.salaryCurrency ?? "").length === 0
      ? undefined
      : {
          amount: preferences.minimumSalary,
          currency: preferences.salaryCurrency as string,
          period: DEFAULT_FLOOR_PERIOD,
        };

  // Only a salary that is *known* to be below the floor removes a job. An
  // unreadable, foreign-currency, or hourly salary leaves the job in place with
  // its printed text — hiding a real job over a missing field is the failure this
  // avoids.
  const kept = fresh.filter((job) => salaryMeetsMinimum(job.salary, floor) !== false);

  const scored = scoreJobs(kept, {
    resume: profile.resume,
    preferences,
    now,
  });

  // Bounded official-careers enrichment. Runs before history is written and
  // before the apply source is recorded, so a discovered destination is what
  // gets persisted. A failure here returns the jobs untouched: discovery is an
  // enrichment, never a gate.
  const enriched = await enrichWithOfficialCareers(
    scored,
    resolveOfficialDiscoveryRunner(options.officialDiscovery),
    now
  );

  const seen = await markJobsSeen(
    userId,
    enriched.map((job) => job.fingerprint),
    now
  );

  const withNewFlag = enriched.map((job) =>
    withSourceEvidence({
      ...job,
      // When the history is unavailable, nothing is called new — see discovery.ts.
      isNew: seen.available && seen.newFingerprints.has(job.fingerprint),
    })
  );

  const newCount = withNewFlag.filter((job) => job.isNew).length;
  const unknownAgeCount = withNewFlag.filter((job) => job.posted === undefined).length;
  const salaryKnownCount = withNewFlag.filter((job) => job.salary !== undefined).length;

  // The per-board `matched` counts are taken before the global freshness/salary
  // filters, so they can exceed what survives. `directSourcePostings` is the
  // honest, user-visible number: direct-source jobs in the final result.
  const directVisible = withNewFlag.filter((job) => job.source !== "Google Jobs").length;

  const metadata: JobSearchMetadata = {
    total: withNewFlag.length,
    freshCount: withNewFlag.filter((job) => job.isFresh).length,
    newCount,
    salaryKnownCount,
    belowMinimumCount: fresh.length - kept.length,
    unknownAgeCount,
    searchedRoles: plan.roles,
    searchedLocations: plan.locations,
    searchCount: attempts.length,
    failedSearchCount: failed.length,
    rawCount,
    duplicateCount,
    directSourcePostings: directVisible,
    directSourceBoards: direct.reports.length,
    ...(direct.reports.length === 0 ? {} : { directSources: direct.reports }),
    freshnessDays: preferences.freshnessDays,
    experienceLevel: preferences.experienceLevel as ExperienceLevel,
    scannedAt: now.toISOString(),
    newTrackingAvailable: seen.available,
  };

  // Recorded with the full payload so a page refresh can restore this scan
  // rather than showing an empty state over completed work. Fire-and-forget:
  // a record that does not land costs restore, not the results themselves.
  void recordScan(
    userId,
    {
      total: metadata.total,
      newCount: metadata.newCount,
      searchedRoles: metadata.searchedRoles,
      searchedLocations: metadata.searchedLocations,
      searchCount: metadata.searchCount,
      failedSearchCount: metadata.failedSearchCount,
      newTrackingAvailable: metadata.newTrackingAvailable,
      jobs: withNewFlag,
      metadata,
      attempts,
      resumeFileId: profile.resumeFileId ?? null,
    },
    now
  );

  return { jobs: withNewFlag, metadata, attempts };
}

/**
 * Runs the official-careers stage, tolerating any failure.
 *
 * The caller either injects a runner or takes the configured default. Whatever
 * the runner does — succeed, fail, or throw — this returns an array of jobs. A
 * thrown error is swallowed on purpose: discovery is the only stage that talks
 * to a provider a second time, and it must never be able to turn a good scan
 * into a failed one.
 */
async function enrichWithOfficialCareers(
  jobs: readonly NormalizedJob[],
  runner: OfficialDiscoveryRunner | null,
  now: Date
): Promise<NormalizedJob[]> {
  if (runner === null) {
    return [...jobs];
  }

  try {
    const results = await runner(jobs, now);
    return attachOfficialDestinations(jobs, results, now);
  } catch {
    return [...jobs];
  }
}

/**
 * Chooses the discovery runner: an injected one when a test provided it, the
 * configured default otherwise. Missing configuration resolves to `null`.
 */
function resolveOfficialDiscoveryRunner(
  override: OfficialDiscoveryRunner | null | undefined
): OfficialDiscoveryRunner | null {
  if (override !== undefined) {
    return override;
  }

  try {
    return buildOfficialDiscoveryRunner();
  } catch {
    // A misconfigured environment disables discovery; it never breaks a scan.
    return null;
  }
}

/**
 * Runs the employer-board stage, tolerating any failure.
 *
 * Board discovery is an enrichment, not a gate: a thrown error, a bad board, or a
 * disabled stage all resolve to "no extra jobs" and leave the search results
 * exactly as they were.
 */
async function enrichWithDirectSources(
  jobs: readonly NormalizedJob[],
  roles: readonly string[],
  runner: DirectSourceRunner | null,
  now: Date
): Promise<{ jobs: NormalizedJob[]; reports: DirectSourceReport[] }> {
  if (runner === null) {
    return { jobs: [], reports: [] };
  }

  try {
    const outcome = await runner(jobs, roles, now);
    return { jobs: outcome.jobs, reports: outcome.reports };
  } catch {
    return { jobs: [], reports: [] };
  }
}

/**
 * Chooses the direct-source runner: an injected one when a test provided it, the
 * configured default otherwise. Missing configuration resolves to `null`.
 */
function resolveDirectSourceRunner(
  override: DirectSourceRunner | null | undefined
): DirectSourceRunner | null {
  if (override !== undefined) {
    return override;
  }

  try {
    return buildDirectSourceRunner();
  } catch {
    return null;
  }
}

/** One query's raw results plus the record of whether it worked. */
type SearchOutcome = {
  attempt: SearchAttempt;
  /** Raw entries, before normalization. */
  raw: SerpApiJobResult[];
};

/**
 * Runs a single planned query.
 *
 * Never throws: a failure becomes an `attempt` with `ok: false` and a message that
 * is already safe to show, because `SerpApiError.message` is written for humans
 * and the provider's own text stays in `detail`.
 *
 * One fallback applies: level/type qualifiers are *query text*, not a filter, so
 * in a locale whose postings never say "entry level" the qualified query returns
 * zero results while the bare role returns plenty. When that happens the query
 * is retried once with just the role — same location, same plan, no invented
 * terms — so a qualifier that starves a search cannot leave the user with
 * nothing. The attempt records the query that actually produced the results.
 * A retry that itself fails keeps the original empty answer rather than
 * downgrading a successful (if empty) search into a failure.
 */
async function runSearch(
  search: PlannedSearch,
  fetchJobs: NonNullable<SearchJobsOptions["fetchJobs"]>
): Promise<SearchOutcome> {
  const attempt: SearchAttempt = {
    query: search.q,
    ...(search.location === undefined ? {} : { location: search.location }),
    ...(search.role === undefined ? {} : { role: search.role }),
    ok: false,
    resultCount: 0,
  };

  try {
    let { jobs } = await fetchJobs(search);
    let effectiveQuery = search.q;

    if (jobs.length === 0 && search.role !== undefined && search.q !== search.role) {
      const relaxed: PlannedSearch = { ...search, q: search.role };
      try {
        const retry = await fetchJobs(relaxed);
        if (retry.jobs.length > 0) {
          jobs = retry.jobs;
          effectiveQuery = relaxed.q;
        }
      } catch {
        // Keep the first search's empty answer; it succeeded.
      }
    }

    return {
      attempt: { ...attempt, query: effectiveQuery, ok: true, resultCount: jobs.length },
      raw: jobs,
    };
  } catch (error) {
    return {
      attempt: { ...attempt, ok: false, error: describeFailure(error) },
      raw: [],
    };
  }
}

/** The default transport: real SerpApi, one bounded page walk per query. */
async function defaultFetcher(search: PlannedSearch) {
  // Country-aware gl/hl: SerpApi returns zero results for many non-US
  // locations when left at gl=us hl=en (e.g. Berlin needs gl=de hl=de).
  const locale = resolveSearchLocale(search.location ?? "");
  // Global/remote phrases (e.g. "worldwide") are rejected by google_jobs, so
  // they are sent as no location at all; that returns worldwide results.
  const providerLocation = toProviderLocation(search.location);
  return searchGoogleJobsPages(
    {
      q: search.q,
      ...(providerLocation === undefined ? {} : { location: providerLocation }),
      hl: locale.hl,
      gl: locale.gl,
    },
    MAX_PAGES_PER_SEARCH
  );
}

/** A message that is safe to put in a response body. */
function describeFailure(error: unknown): string {
  if (error instanceof SerpApiError) {
    return error.message;
  }

  if (error instanceof Error && error.message.length > 0) {
    // Still safe: this is an error raised inside this app, never a provider body.
    return error.message;
  }

  return "This search could not be completed.";
}

/** Picks the error code for a scan where every query failed. */
function toSearchError(failed: readonly SearchAttempt[]): JobSearchError {
  const kinds = failed.map((attempt) => attempt.error ?? "");

  if (kinds.some((message) => /no capacity|try again shortly/i.test(message))) {
    return new JobSearchError(
      "serpapi_rate_limited",
      "The job search provider has no capacity left right now. Try again shortly."
    );
  }

  if (kinds.some((message) => /not configured/i.test(message))) {
    return new JobSearchError("serpapi_not_configured", "Job search is not configured on this server.");
  }

  if (kinds.some((message) => /unexpected response|unreadable response/i.test(message))) {
    return new JobSearchError(
      "serpapi_malformed_response",
      "The job search provider returned an unexpected response."
    );
  }

  if (kinds.some((message) => /could not be reached|rejected the request/i.test(message))) {
    return new JobSearchError(
      "serpapi_unavailable",
      "The job search provider could not be reached. Try again shortly."
    );
  }

  return new JobSearchError("serpapi_failed", "The job search could not be completed.");
}

/** Trims and drops blanks, preserving order. */
function cleanList(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Loads the profile, turning a missing one into the domain error the route maps. */
async function loadProfile(userId: string): Promise<StoredProfile> {
  const profile = await getProfileByUserId(userId);

  if (profile === null) {
    throw new JobSearchError(
      "profile_not_found",
      "No profile found for this user. Upload a resume and review your profile first."
    );
  }

  return profile;
}