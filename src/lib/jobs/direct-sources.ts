import { getServerEnv } from "@/lib/env";
import {
  atsLocationOf,
  fetchBoard,
  type AtsPlatform,
  type DirectPosting,
  type HttpGetter,
} from "@/lib/jobs/ats";
import { roleFamily, tenantMatchesEmployer } from "@/lib/jobs/employer";
import { buildFingerprint } from "@/lib/jobs/normalize";
import { runPool } from "@/lib/jobs/pool";
import { tokenize } from "@/lib/jobs/text";
import type {
  DirectSourceReport,
  JobDiscoverySource,
  NormalizedJob,
  PostedAge,
} from "@/lib/jobs/types";

/**
 * Employer-board discovery: asking an employer what it is hiring for.
 *
 * Everything upstream of this module finds a job by *searching*. This stage is
 * the other direction. Once a listing's own link proves which ATS board belongs
 * to the employer, this stage asks that board directly for every posting it is
 * advertising — including the ones a search did not surface.
 *
 * Two rules keep it honest:
 *
 * 1. **A board is only queried when the provider itself returned its link.** The
 *    board token is read out of that URL and the tenant is verified against the
 *    advertised employer before any request. No domain is guessed and no board is
 *    crawled.
 * 2. **A posting only enters the scan when it matches a target role.** Boards can
 *    hold thousands of postings; the role filter plus the per-board and total
 *    caps keep the contribution relevant and bounded.
 *
 * The output is ordinary {@link NormalizedJob} values, so board postings flow
 * through the same freshness, salary, scoring, deduplication, and apply-source
 * stages as search results. Downstream code only distinguishes them by `source`.
 */

/** One employer board worth querying, harvested from the listings themselves. */
export type DirectSourceTarget = {
  platform: AtsPlatform;
  /** The board token, exactly as it appeared in the employer's own link. */
  tenant: string;
  /** The employer name the listing advertised and the token was verified against. */
  employer: string;
  /** Ids of the listings that seeded this target, for diagnostics. */
  seededBy: string[];
};

/** The result of one scan's direct-source stage. */
export type DirectSourceOutcome = {
  /** Extra jobs contributed by employer boards. */
  jobs: NormalizedJob[];
  /** Per-board outcomes, for the coverage disclosure. Never a silent failure. */
  reports: DirectSourceReport[];
};

/** Timing and transport for a run, injected so tests never touch a network. */
export type DirectSourceDeps = {
  now: Date;
  /** Maximum distinct boards queried in one scan. `0` disables the stage. */
  maxTargets: number;
  /** Maximum matched postings taken from any one board. */
  maxPostingsPerBoard: number;
  /** Maximum matched postings added to a scan across all boards. */
  maxTotalPostings: number;
  /** How many boards are fetched at once. */
  concurrency: number;
  /** HTTP transport override (tests). Defaults to the real fetch. */
  get?: HttpGetter;
  /** Per-board timeout override. */
  timeoutMs?: number;
};

/** A runner bound to fixed configuration, called per scan with the live clock. */
export type DirectSourceRunner = (
  jobs: readonly NormalizedJob[],
  roles: readonly string[],
  now: Date
) => Promise<DirectSourceOutcome>;

/**
 * Picks the employer boards a scan should query.
 *
 * A board enters only through a URL the provider actually returned, on a listing
 * whose advertised employer the board token matches. The first `maxTargets`
 * distinct boards win, in listing order; duplicates collapse so one employer is
 * queried once no matter how many of its listings appeared.
 */
export function harvestDirectSourceTargets(
  jobs: readonly NormalizedJob[],
  maxTargets: number
): DirectSourceTarget[] {
  const limit = Number.isFinite(maxTargets) ? Math.max(0, Math.trunc(maxTargets)) : 0;
  if (limit === 0) {
    return [];
  }

  const targets = new Map<string, DirectSourceTarget>();

  for (const job of jobs) {
    const company = typeof job.company === "string" ? job.company.trim() : "";
    if (company.length === 0) {
      continue;
    }

    for (const url of jobUrls(job)) {
      const location = atsLocationOf(url);
      if (location === null) {
        continue;
      }

      // The provider returned this URL, but a familiar ATS host is not proof it
      // is *this* employer's board. The tenant has to match the advertised name.
      if (!tenantMatchesEmployer(location.tenant, company)) {
        continue;
      }

      const key = `${location.platform}|${location.tenant}`;
      const existing = targets.get(key);
      if (existing === undefined) {
        targets.set(key, {
          platform: location.platform,
          tenant: location.tenant,
          employer: company,
          seededBy: [job.id],
        });
      } else if (!existing.seededBy.includes(job.id)) {
        existing.seededBy.push(job.id);
      }
    }
  }

  return [...targets.values()].slice(0, limit);
}

/**
 * True when a board posting is one of the roles the user asked for.
 *
 * Deliberately conservative: when both sides have a recognised role family they
 * must agree, so "Software Engineer" never pulls in a sales or finance posting
 * that merely shares a word. Otherwise the fallback is a *distinctive* shared
 * token (four characters or more), keeping "Software Engineer" matching "Senior
 * Software Engineer" without matching the bare word "Engineer" onto everything.
 */
export function postingMatchesRoles(title: string, roles: readonly string[]): boolean {
  const titleFamily = roleFamily(title);
  const titleTokens = new Set(tokenize(title));

  for (const role of roles) {
    const roleTokens = tokenize(role);
    if (roleTokens.length === 0) {
      continue;
    }

    const roleName = roleFamily(role);
    if (titleFamily !== null && roleName !== null) {
      if (titleFamily === roleName) {
        return true;
      }
      continue;
    }

    if (roleTokens.some((token) => token.length >= 4 && titleTokens.has(token))) {
      return true;
    }
  }

  return false;
}

/**
 * Runs the employer-board stage, tolerating any single board's failure.
 *
 * One unreachable or rate-limited board becomes a report entry, never a broken
 * scan: the other boards still contribute.
 */
export async function discoverDirectPostings(
  jobs: readonly NormalizedJob[],
  roles: readonly string[],
  deps: DirectSourceDeps
): Promise<DirectSourceOutcome> {
  const targets = harvestDirectSourceTargets(jobs, deps.maxTargets);
  if (targets.length === 0 || roles.length === 0) {
    return { jobs: [], reports: [] };
  }

  const perBoard = Number.isFinite(deps.maxPostingsPerBoard)
    ? Math.max(0, Math.trunc(deps.maxPostingsPerBoard))
    : 0;
  const total = Number.isFinite(deps.maxTotalPostings)
    ? Math.max(0, Math.trunc(deps.maxTotalPostings))
    : 0;

  const reports: DirectSourceReport[] = [];
  const chosen: { target: DirectSourceTarget; posting: DirectPosting }[] = [];
  const seen = new Set<string>();

  await runPool(targets, deps.concurrency, async (target) => {
    const result = await fetchBoard(
      { platform: target.platform, tenant: target.tenant },
      {
        ...(deps.get === undefined ? {} : { get: deps.get }),
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      }
    );

    const matched = result.postings
      .filter((posting) => postingMatchesRoles(posting.title, roles))
      // Newest first; a board that states no date sorts last, never first.
      .sort((a, b) => timestampOf(b) - timestampOf(a))
      .slice(0, perBoard);

    for (const posting of matched) {
      const id = directJobId(posting);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      chosen.push({ target, posting });
    }

    reports.push({
      platform: target.platform,
      tenant: target.tenant,
      employer: target.employer,
      status: result.status,
      returned: result.postings.length,
      matched: 0,
    });
  });

  // Enforce the cross-board total deterministically: newest first, then id, so
  // the same boards with the same postings always yield the same jobs.
  chosen.sort(
    (a, b) =>
      timestampOf(b.posting) - timestampOf(a.posting) ||
      directJobId(a.posting).localeCompare(directJobId(b.posting))
  );

  const limited = chosen.slice(0, total);
  const contributed = new Map<string, number>();
  for (const { target } of limited) {
    const key = `${target.platform}|${target.tenant}`;
    contributed.set(key, (contributed.get(key) ?? 0) + 1);
  }

  const directJobs = limited.map(({ target, posting }) =>
    toNormalizedPosting(posting, target.employer, deps.now)
  );

  // A report claims only what actually entered the scan, never what was fetched.
  for (const report of reports) {
    report.matched = contributed.get(`${report.platform}|${report.tenant}`) ?? 0;
  }

  reports.sort(
    (a, b) => a.employer.localeCompare(b.employer) || a.tenant.localeCompare(b.tenant)
  );

  return { jobs: directJobs, reports };
}

/**
 * Converts a board posting into a {@link NormalizedJob}.
 *
 * The posting's own board URL is the apply destination, and the employer is the
 * name the listing advertised — the board is authoritative for the posting, the
 * listing is authoritative for the name it was discovered under.
 */
export function toNormalizedPosting(
  posting: DirectPosting,
  employer: string,
  now: Date
): NormalizedJob {
  const label = PLATFORM_SOURCE[posting.platform];
  const posted = postingPostedAge(posting, now);
  const fingerprint = buildFingerprint({
    title: posting.title,
    company: employer,
    location: posting.location ?? null,
    url: posting.url,
  });

  return {
    id: directJobId(posting),
    fingerprint,
    title: posting.title,
    company: employer,
    ...(posting.location === undefined ? {} : { location: posting.location }),
    source: label,
    ...(posting.remote === undefined ? {} : { isRemote: posting.remote }),
    applyUrl: posting.url,
    applyUrlPublisher: label,
    applyOptions: [{ publisher: label, url: posting.url }],
    ...(posted === null ? {} : { posted }),
    isFresh: false,
    isNew: false,
    relevanceScore: 0,
    relevanceReasons: [],
  };
}

/**
 * The honest posting age for a board job.
 *
 * A board states a date, not Google's relative text, so `text` is that date and
 * `days` is computed from it. A date older than a year is treated as unknown
 * rather than rendered as an implausible age, matching the search path's ceiling.
 */
export function postingPostedAge(posting: DirectPosting, now: Date): PostedAge | null {
  const iso = posting.publishedAt ?? posting.updatedAt;
  if (iso === undefined) {
    return null;
  }

  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return null;
  }

  const days = Math.floor((now.getTime() - time) / 86_400_000);
  if (days > 365) {
    return null;
  }

  return { days: Math.max(0, days), text: iso.slice(0, 10) };
}

/** A posting's identity, stable across scans: platform + tenant + posting id. */
export function directJobId(posting: DirectPosting): string {
  return `ats:${posting.platform}:${posting.tenant}:${posting.postingId}`;
}

/** Everything a job offers as a link, most-specific first. */
function jobUrls(job: NormalizedJob): string[] {
  const urls: string[] = [];

  for (const option of job.applyOptions ?? []) {
    if (typeof option.url === "string" && option.url.length > 0) {
      urls.push(option.url);
    }
  }

  if (job.applyUrl !== undefined) {
    urls.push(job.applyUrl);
  }

  if (job.googleJobsUrl !== undefined) {
    urls.push(job.googleJobsUrl);
  }

  return urls;
}

/** Epoch millis for a board posting, or 0 when the board stated no date. */
function timestampOf(posting: DirectPosting): number {
  const iso = posting.publishedAt ?? posting.updatedAt;
  if (iso === undefined) {
    return 0;
  }

  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
}

/** A stable, typed label for a platform's jobs. */
const PLATFORM_SOURCE: Record<AtsPlatform, JobDiscoverySource> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
};

/**
 * Binds fixed configuration into a runner the orchestrator calls once per scan.
 */
export function createDirectSourceRunner(
  options: Omit<DirectSourceDeps, "now">
): DirectSourceRunner {
  return (jobs, roles, now) => discoverDirectPostings(jobs, roles, { ...options, now });
}

/**
 * Builds the configured runner, or `null` when the stage is disabled.
 *
 * Direct-source discovery needs no API key — these are public, unauthenticated
 * board endpoints — so it is on by default (`DIRECT_SOURCE_MAX_TARGETS` defaults
 * above zero) and off only when that ceiling is explicitly set to `0`.
 */
export function buildDirectSourceRunner(): DirectSourceRunner | null {
  const env = getServerEnv();
  const maxTargets = env.DIRECT_SOURCE_MAX_TARGETS;

  if (!Number.isFinite(maxTargets) || maxTargets <= 0) {
    return null;
  }

  return createDirectSourceRunner({
    maxTargets,
    maxPostingsPerBoard: env.DIRECT_SOURCE_MAX_POSTINGS_PER_BOARD,
    maxTotalPostings: env.DIRECT_SOURCE_MAX_TOTAL_POSTINGS,
    concurrency: Math.max(1, env.DIRECT_SOURCE_CONCURRENCY),
  });
}
