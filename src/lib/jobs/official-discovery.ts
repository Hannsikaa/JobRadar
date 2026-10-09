import { getServerEnv } from "@/lib/env";
import { isOfficialJob } from "@/lib/jobs/apply-source";
import { employerSlug } from "@/lib/jobs/employer";
import {
  createMongoDestinationCache,
  type DestinationCache,
} from "@/lib/jobs/official-cache";
import {
  discoverOfficialDestination,
  type DiscoveredDestination,
  type DiscoveryTarget,
  type OfficialDiscoveryOutcome,
  type OfficialDiscoveryResult,
  type WebSearch,
} from "@/lib/jobs/official-careers";
import { normalizeName, normalizeUrl } from "@/lib/jobs/text";
import type { NormalizedJob } from "@/lib/jobs/types";
import { searchWeb } from "@/lib/serpapi/client";

/**
 * Bounded official-careers enrichment.
 *
 * The existing scan already spends a metered SerpApi budget on the role/location
 * plan. This stage adds a *second*, tightly bounded set of lookups: at most
 * `maxTargets` distinct employer+role+location searches per scan, run with a
 * small concurrency limit, cached across scans and users, and skipped entirely
 * for jobs that already have a verified destination.
 *
 * Three invariants hold no matter what the provider does:
 *
 * 1. **Discovery can never fail a scan.** Every lookup is wrapped; a failure
 *    becomes an outcome on that one job, and the job is still returned with its
 *    original links.
 * 2. **A destination is attached to one job only.** Results are keyed by job id.
 * 3. **A negative result is remembered, not retried forever.** The cache stores
 *    "found nothing" as well as "found it", with a shorter life.
 */

/** Everything the orchestration needs, injected so it is testable without a network. */
export type OfficialDiscoveryDeps = {
  search: WebSearch;
  /** Optional: a cache that is down degrades to "look it up again". */
  cache?: DestinationCache | null;
  now: Date;
  /** Maximum distinct employer+role+location lookups for one scan. */
  maxTargets: number;
  /** How many lookups may run at once. */
  concurrency: number;
  /** Lifetime of a verified destination. */
  positiveTtlMs: number;
  /** Lifetime of a negative or neutral outcome. */
  negativeTtlMs: number;
};

/** A runner the orchestrator can call with the scored jobs for one scan. */
export type OfficialDiscoveryRunner = (
  jobs: readonly NormalizedJob[],
  now: Date
) => Promise<Map<string, OfficialDiscoveryResult>>;

/** One distinct lookup: the employer/role key, a representative, and its jobs. */
type DiscoveryGroup = {
  key: string;
  target: DiscoveryTarget;
  jobIds: string[];
  score: number;
};

/**
 * The cache key for a listing.
 *
 * Employer identity, role, and location — never a URL, and never anything the
 * provider returned. Two listings that share it are the same employer hiring for
 * the same role in the same place, so one lookup serves both. A listing with no
 * employer or title is not cacheable and not discoverable.
 */
export function officialDiscoveryKey(job: {
  company?: string;
  title: string;
  location?: string;
}): string | null {
  const company = employerSlug(job.company ?? "");
  const title = normalizeName(job.title);
  if (company.length === 0 || title.length === 0) {
    return null;
  }

  return `${company}|${title}|${normalizeName(job.location ?? "")}`;
}

/**
 * Picks the bounded set of listings worth a lookup.
 *
 * Jobs that already have a verified destination are skipped — re-searching them
 * would spend budget to learn nothing. Remaining jobs are grouped by cache key so
 * a repeated employer is looked up once, then ordered by relevance score so the
 * budget goes to the most promising listings.
 */
export function selectDiscoveryGroups(
  jobs: readonly NormalizedJob[],
  maxTargets: number
): DiscoveryGroup[] {
  // Defensive: a non-finite limit is treated as "off", never as "unlimited".
  const limit = Number.isFinite(maxTargets) ? Math.max(0, Math.trunc(maxTargets)) : 0;

  if (limit === 0) {
    return [];
  }

  const byKey = new Map<string, DiscoveryGroup>();

  for (const job of jobs) {
    if (isOfficialJob(job)) {
      continue;
    }

    const key = officialDiscoveryKey(job);
    if (key === null) {
      continue;
    }

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        key,
        target: {
          id: job.id,
          title: job.title,
          ...(job.company === undefined ? {} : { company: job.company }),
          ...(job.location === undefined ? {} : { location: job.location }),
        },
        jobIds: [job.id],
        score: job.relevanceScore,
      });
    } else {
      existing.jobIds.push(job.id);
      existing.score = Math.max(existing.score, job.relevanceScore);
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Resolves official destinations for the promising listings.
 *
 * Order per group: cache, then (only on a miss) one provider lookup. Whatever the
 * result, it is written back with the appropriate lifetime. Groups run through a
 * fixed-size pool so concurrency stays bounded and provider-friendly.
 */
export async function resolveOfficialDestinations(
  jobs: readonly NormalizedJob[],
  deps: {
    search: WebSearch;
    cache?: DestinationCache | null;
    now: Date;
    maxTargets: number;
    concurrency: number;
    positiveTtlMs: number;
    negativeTtlMs: number;
  }
): Promise<Map<string, OfficialDiscoveryResult>> {
  const groups = selectDiscoveryGroups(jobs, deps.maxTargets);
  const results = new Map<string, OfficialDiscoveryResult>();

  if (groups.length === 0) {
    return results;
  }

  await runPool(groups, deps.concurrency, async (group) => {
    const cached = deps.cache === undefined || deps.cache === null
      ? null
      : await deps.cache.read(group.key, deps.now);

    const outcome: OfficialDiscoveryOutcome =
      cached ?? (await discoverOfficialDestination(group.target, deps.search));

    if (cached === null) {
      const ttl = outcome.destination === undefined ? deps.negativeTtlMs : deps.positiveTtlMs;
      await deps.cache?.write(group.key, outcome, ttl, deps.now);
    }

    for (const jobId of group.jobIds) {
      results.set(jobId, { ...outcome, jobId });
    }
  });

  return results;
}

/** A fixed-size worker pool; each worker drains the shared queue. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), items.length) : 1;
  let next = 0;

  const workers = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        await worker(item);
      }
    }
  });

  await Promise.all(workers);
}

/**
 * Attaches discovery outcomes to the jobs they belong to.
 *
 * A verified destination is *added* to the listing's existing apply options, not
 * substituted for them, so the original evidence is preserved and the selector
 * can still rank. The outcome itself is recorded on the job for every status, so
 * the card can say what was checked rather than only what was found.
 */
export function attachOfficialDestinations(
  jobs: readonly NormalizedJob[],
  results: ReadonlyMap<string, OfficialDiscoveryResult>,
  now: Date
): NormalizedJob[] {
  if (results.size === 0) {
    return [...jobs];
  }

  return jobs.map((job) => {
    const result = results.get(job.id);
    if (result === undefined) {
      return job;
    }

    const resolvedAt = now.toISOString();
    const discovery = {
      status: result.status,
      evidence: result.evidence,
      resolvedAt,
    } as const;

    if (result.destination === undefined) {
      return { ...job, officialDiscovery: discovery };
    }

    const destination = result.destination;
    const existing = job.applyOptions ?? [];
    const alreadyPresent = existing.some(
      (option) => normalizeUrl(option.url) === normalizeUrl(destination.url)
    );

    const applyOptions = alreadyPresent
      ? existing
      : [toApplyOption(destination), ...existing];

    return {
      ...job,
      applyOptions,
      applyUrl: job.applyUrl ?? destination.url,
      applyUrlPublisher: job.applyUrlPublisher ?? destination.provider,
      officialDiscovery: discovery,
    };
  });
}

/** The apply option a discovered destination contributes. */
function toApplyOption(destination: DiscoveredDestination): {
  publisher: string;
  url: string;
} {
  return { publisher: destination.provider, url: destination.url };
}

/**
 * Builds the production runner from configuration, or `null` when discovery is
 * disabled (no SerpApi key, or `OFFICIAL_DISCOVERY_MAX_TARGETS=0`).
 *
 * The runner owns the real web-search call and the cache, and pulls its limits
 * from the environment so the provider budget is explicit rather than implied.
 */
export function createOfficialDiscoveryRunner(options: {
  search: WebSearch;
  cache?: DestinationCache | null;
  maxTargets: number;
  concurrency: number;
  positiveTtlMs: number;
  negativeTtlMs: number;
}): OfficialDiscoveryRunner {
  return (jobs, now) =>
    resolveOfficialDestinations(jobs, {
      search: options.search,
      cache: options.cache ?? null,
      now,
      maxTargets: options.maxTargets,
      concurrency: options.concurrency,
      positiveTtlMs: options.positiveTtlMs,
      negativeTtlMs: options.negativeTtlMs,
    });
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The configured runner, or `null` when discovery is off.
 *
 * Off means either there is no SerpApi key (nothing to search with) or the
 * target budget is zero. Returning `null` rather than a no-op keeps the check in
 * one place and lets the orchestrator skip the stage entirely.
 *
 * The one call this feature adds to a scan is the web lookup per uncached
 * employer+role; the bound is `OFFICIAL_DISCOVERY_MAX_TARGETS`, capped at 25 in
 * the environment schema so no configuration can make a scan unbounded.
 */
export function buildOfficialDiscoveryRunner(): OfficialDiscoveryRunner | null {
  const env = getServerEnv();

  // Coerce defensively: a missing value disables discovery rather than
  // defaulting to an unbounded scan.
  const maxTargets = Number(env.OFFICIAL_DISCOVERY_MAX_TARGETS ?? 0);
  const concurrency = Number(env.OFFICIAL_DISCOVERY_CONCURRENCY ?? 1);

  if (env.SERPAPI_API_KEY === undefined || !Number.isFinite(maxTargets) || maxTargets <= 0) {
    return null;
  }

  const search: WebSearch = async (query) => {
    const response = await searchWeb({ q: query, num: 10 });

    return (response.organic_results ?? []).map((result) => ({
      ...(result.title === undefined ? {} : { title: result.title }),
      ...(result.link === undefined ? {} : { link: result.link }),
      ...(result.snippet === undefined ? {} : { snippet: result.snippet }),
    }));
  };

  return createOfficialDiscoveryRunner({
    search,
    cache: createMongoDestinationCache(),
    maxTargets,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1,
    positiveTtlMs: Number(env.OFFICIAL_DISCOVERY_CACHE_TTL_DAYS ?? 7) * MS_PER_DAY,
    negativeTtlMs: Number(env.OFFICIAL_DISCOVERY_NEGATIVE_TTL_HOURS ?? 24) * MS_PER_HOUR,
  });
}
