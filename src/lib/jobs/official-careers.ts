import { classifyDestination, hostOf, knownAtsName } from "@/lib/jobs/apply-source";
import { roleFamily, titlesAreConsistent } from "@/lib/jobs/employer";
import { normalizeWhitespace, tokenize } from "@/lib/jobs/text";
import type { JobSourceKind, OfficialDiscoveryStatus } from "@/lib/jobs/types";

/**
 * Official-careers discovery: finding the employer's own job page, or an
 * employer-specific ATS posting, for a listing Google Jobs surfaced.
 *
 * The listing Google returns is a *candidate* — its company, title, and apply
 * links may not agree with one another (the Pinterest/Granite and Home
 * Depot/Blue Origin failures). This module runs one bounded web search and then
 * decides, from evidence, whether a result is the same employer *and* the same
 * role. It never guesses a domain, never treats the first result as official,
 * and never invents a URL: every destination it can return is a URL the search
 * provider actually returned.
 *
 * The decision is deliberately conservative. A missing match is `unverified`,
 * never a claim that the listing is fraudulent:
 *
 *   verified_official_job      employer's own domain, matching title
 *   verified_employer_ats_job  recognised ATS whose tenant matches, matching title
 *   employer_found_no_job      employer's domain/ATS seen, but no matching role
 *   employer_mismatch          an ATS posting that belongs to somebody else
 *   role_mismatch              same employer, a clearly different role
 *   location_mismatch          same employer and role, an incompatible location
 *   no_employer_domain         nothing that could be tied to the employer
 *   provider_error             the lookup itself failed
 */

/** The part of a listing discovery needs. Kept narrow so it stays pure. */
export type DiscoveryTarget = {
  id: string;
  title: string;
  company?: string;
  location?: string;
};

/** One organic search result, as far as discovery trusts it. */
export type WebCandidate = {
  title?: string;
  link?: string;
  snippet?: string;
};

/** The injected lookup. A failure is expected and handled by the caller. */
export type WebSearch = (query: string) => Promise<readonly WebCandidate[]>;

/** A verified destination, ready to be attached to a job. */
export type DiscoveredDestination = {
  url: string;
  kind: JobSourceKind;
  /** ATS vendor name, or the employer host for an official page. */
  provider: string;
  evidence: string[];
};

/** The outcome of one discovery lookup, without the job id. Cacheable as-is. */
export type OfficialDiscoveryOutcome = {
  status: OfficialDiscoveryStatus;
  destination?: DiscoveredDestination;
  evidence: string[];
};

/** An outcome bound to the job it was resolved for. */
export type OfficialDiscoveryResult = OfficialDiscoveryOutcome & { jobId: string };

/** Query length ceiling, so a pathological title cannot build a huge request. */
const MAX_QUERY_LENGTH = 220;

/** Host paths that are career hubs, not postings. Never send a user to one. */
const LISTING_HOME_PATTERN =
  /^(careers?|jobs?|job|positions|openings|vacanc(y|ies)|opportunit(y|ies))$/i;

/**
 * Runs the lookup and evaluates it. Never throws: a provider failure is an
 * outcome, not an error, because discovery must not be able to break a scan.
 */
export async function discoverOfficialDestination(
  job: DiscoveryTarget,
  search: WebSearch
): Promise<OfficialDiscoveryResult> {
  const query = buildOfficialQuery(job);

  if (query === null) {
    return {
      jobId: job.id,
      status: "no_employer_domain",
      evidence: ["The listing names no employer and title to verify a destination against."],
    };
  }

  let results: readonly WebCandidate[];
  try {
    results = await search(query);
  } catch {
    return {
      jobId: job.id,
      status: "provider_error",
      evidence: ["The official-careers lookup could not be completed."],
    };
  }

  return { ...evaluateCandidates(job, results), jobId: job.id };
}

/**
 * The discovery query for a listing, or `null` when there is nothing to search.
 *
 * The company and title are always included. A concrete location is added when
 * the listing has one, because a global Google result for "Engineer" is far more
 * likely to be the wrong office than the right one.
 */
export function buildOfficialQuery(job: DiscoveryTarget): string | null {
  const company = normalizeWhitespace(job.company ?? "");
  const title = normalizeWhitespace(job.title ?? "");

  if (company.length < 2 || title.length < 2) {
    return null;
  }

  const parts = [company, title];
  const location = concreteLocation(job.location);
  if (location !== null) {
    parts.push(location);
  }

  return parts.join(" ").slice(0, MAX_QUERY_LENGTH);
}

/** A location worth putting in a query; `remote`/`worldwide` are not. */
function concreteLocation(location: string | undefined): string | null {
  if (typeof location !== "string") {
    return null;
  }

  const trimmed = normalizeWhitespace(location);
  if (trimmed.length === 0) {
    return null;
  }

  if (/\b(remote|worldwide|anywhere|global|work from home|wfh)\b/i.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/** Which candidate, if any, wins, and the honest reason when none does. */
type CandidateSet = {
  officialJob: DiscoveredDestination | null;
  atsJob: DiscoveredDestination | null;
  employerSiteSeen: boolean;
  employerAtsSeen: boolean;
  foreignAtsSeen: boolean;
  roleMismatch: boolean;
  locationMismatch: boolean;
};

/**
 * Evaluates search results against the listing.
 *
 * Every result is classified by the same evidence model the Apply button uses,
 * so discovery and the UI can never disagree about what "official" means. Only a
 * result that is (a) owned by the employer, (b) a job posting rather than a
 * careers hub, and (c) title-consistent can become a destination.
 */
export function evaluateCandidates(
  job: DiscoveryTarget,
  results: readonly WebCandidate[]
): OfficialDiscoveryOutcome {
  const company = job.company ?? "";
  const candidates: CandidateSet = {
    officialJob: null,
    atsJob: null,
    employerSiteSeen: false,
    employerAtsSeen: false,
    foreignAtsSeen: false,
    roleMismatch: false,
    locationMismatch: false,
  };

  for (const result of results) {
    const link = typeof result.link === "string" ? result.link.trim() : "";
    const host = hostOf(link);

    if (link.length === 0 || host === null) {
      continue;
    }

    const classification = classifyDestination(link, company, job.title);

    if (classification.kind === "third_party" || classification.kind === "unverified") {
      // A recognised ATS that did not match the employer is exactly the failure
      // this stage exists to prevent; remember that we saw one, but never use it.
      if (knownAtsName(host) !== null) {
        candidates.foreignAtsSeen = true;
      }
      continue;
    }

    if (classification.kind === "official_company_site") {
      candidates.employerSiteSeen = true;
    } else {
      candidates.employerAtsSeen = true;
    }

    const pageTitle = normalizeWhitespace(result.title ?? "");
    const pageFamily = roleFamily(pageTitle);
    const jobFamily = roleFamily(job.title);

    if (!titleMatchesJob(job.title, pageTitle)) {
      // A generic "Careers at Acme" is the employer's site without the role, not
      // a role mismatch. Only a page naming a *different* role is a mismatch.
      if (pageFamily !== null && jobFamily !== null && pageFamily !== jobFamily) {
        candidates.roleMismatch = true;
      }
      continue;
    }

    if (!looksLikeJobPosting(link)) {
      // The employer's own careers page, but not a specific posting.
      continue;
    }

    if (locationConflicts(job.location, `${pageTitle} ${result.snippet ?? ""}`)) {
      candidates.locationMismatch = true;
      continue;
    }

    const destination: DiscoveredDestination =
      classification.kind === "official_company_site"
        ? {
            url: link,
            kind: "official_company_site",
            provider: host,
            evidence: [
              `Found on ${host}, the employer's own domain.`,
              `Page title "${normalizeWhitespace(result.title ?? "")}" matches "${job.title}".`,
            ],
          }
        : {
            url: link,
            kind: "verified_employer_ats",
            provider: knownAtsName(host) ?? classification.provider ?? "employer ATS",
            evidence: [
              `Found a ${knownAtsName(host) ?? "recognised ATS"} posting for "${company}".`,
              `Page title "${normalizeWhitespace(result.title ?? "")}" matches "${job.title}".`,
            ],
          };

    if (destination.kind === "official_company_site") {
      if (candidates.officialJob === null) {
        candidates.officialJob = destination;
      }
    } else if (candidates.atsJob === null) {
      candidates.atsJob = destination;
    }
  }

  return selectOutcome(job, candidates);
}

/** Turns the collected signals into one outcome with a truthful reason. */
function selectOutcome(job: DiscoveryTarget, candidates: CandidateSet): OfficialDiscoveryOutcome {
  const employer = job.company ?? "the employer";

  if (candidates.officialJob !== null) {
    return {
      status: "verified_official_job",
      destination: candidates.officialJob,
      evidence: candidates.officialJob.evidence,
    };
  }

  if (candidates.atsJob !== null) {
    return {
      status: "verified_employer_ats_job",
      destination: candidates.atsJob,
      evidence: candidates.atsJob.evidence,
    };
  }

  if (candidates.locationMismatch) {
    return {
      status: "location_mismatch",
      evidence: [
        `A page for ${employer} was found, but its location does not match this listing's.`,
      ],
    };
  }

  if (candidates.roleMismatch) {
    return {
      status: "role_mismatch",
      evidence: [`A page for ${employer} was found, but for a different role.`],
    };
  }

  if (candidates.foreignAtsSeen) {
    return {
      status: "employer_mismatch",
      evidence: [
        "The only employer-specific posting found belongs to a different employer.",
      ],
    };
  }

  if (candidates.employerSiteSeen || candidates.employerAtsSeen) {
    return {
      status: "employer_found_no_job",
      evidence: [`Found ${employer}'s site, but no posting matching "${job.title}".`],
    };
  }

  return {
    status: "no_employer_domain",
    evidence: [`No page that could be tied to ${employer} was found.`],
  };
}

/**
 * True when a result URL is a job posting rather than a career hub.
 *
 * A bare `…/careers` page is never a destination: sending a user to an
 * employer's careers home instead of the vacancy is the failure this rejects.
 */
export function looksLikeJobPosting(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }

  if (LISTING_HOME_PATTERN.test(segments[0] ?? "")) {
    // `/careers`, `/careers/`, `/jobs/123` — a single hub segment is still a hub.
    return segments.length > 1 && !LISTING_HOME_PATTERN.test(segments[1] ?? "");
  }

  return true;
}

/**
 * Whether a search result's page title describes the same role.
 *
 * It requires the page title to name a role family at all, so a generic "Careers
 * at Acme" can never be mistaken for the job. When the listing's own title names
 * no family, it falls back to a shared distinctive token.
 */
export function titleMatchesJob(jobTitle: string, pageTitle: string): boolean {
  const page = normalizeWhitespace(pageTitle);
  if (page.length === 0) {
    return false;
  }

  const pageFamily = roleFamily(page);
  const jobFamily = roleFamily(jobTitle);

  if (pageFamily === null) {
    return false;
  }

  if (jobFamily !== null) {
    return pageFamily === jobFamily && titlesAreConsistent(jobTitle, page);
  }

  const pageTokens = new Set(tokenize(page));
  return tokenize(jobTitle).some((token) => token.length >= 4 && pageTokens.has(token));
}

/** Country aliases that are specific enough to compare safely. */
const COUNTRY_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/\b(united states|usa|america)\b/i, "us"],
  [/\b(united kingdom|uk|england|scotland|wales)\b/i, "uk"],
  [/\bindia\b/i, "in"],
  [/\b(germany|deutschland)\b/i, "de"],
  [/\bcanada\b/i, "ca"],
  [/\baustralia\b/i, "au"],
  [/\bsingapore\b/i, "sg"],
  [/\b(netherlands|holland)\b/i, "nl"],
  [/\bireland\b/i, "ie"],
  [/\bfrance\b/i, "fr"],
  [/\bspain\b/i, "es"],
  [/\bbrazil\b/i, "br"],
  [/\bmexico\b/i, "mx"],
  [/\bjapan\b/i, "jp"],
  [/\bswitzerland\b/i, "ch"],
  [/\b(united arab emirates|uae)\b/i, "ae"],
];

function countryOf(text: string): string | null {
  for (const [pattern, code] of COUNTRY_ALIASES) {
    if (pattern.test(text)) {
      return code;
    }
  }

  return null;
}

/**
 * Whether a candidate plainly sits in a different country from the listing.
 *
 * Only an explicit country on both sides is a conflict. Anything else abstains
 * (`false`), because guessing a location from loose snippet text would reject
 * real matches far more often than it caught wrong ones.
 */
export function locationConflicts(
  jobLocation: string | undefined,
  candidateText: string
): boolean {
  if (typeof jobLocation !== "string" || jobLocation.trim().length === 0) {
    return false;
  }

  const jobCountry = countryOf(jobLocation);
  const candidateCountry = countryOf(candidateText);

  return jobCountry !== null && candidateCountry !== null && jobCountry !== candidateCountry;
}
