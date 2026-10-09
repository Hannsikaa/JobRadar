import type { ApplyOption, JobSourceKind, NormalizedJob } from "@/lib/jobs/types";
import {
  employerMatchesHost,
  tenantMatchesEmployer,
  titlesAreConsistent,
} from "@/lib/jobs/employer";

export type { JobSourceKind };

/**
 * Deciding where a job's Apply button goes, and how trustworthy that
 * destination is.
 *
 * The old rule — "a known ATS is a direct application" — is what produced the
 * Pinterest failure: a Pinterest listing carried a `granite.wd1.myworkdayjobs.com`
 * option among its links, and because Workday is on an allowlist it outranked the
 * real `pinterestcareers.com` page. The Apply button opened a construction
 * company's Workday page.
 *
 * This module replaces "is the domain familiar?" with "is there evidence this
 * destination belongs to *this* employer?"
 *
 *   official_company_site  the host plausibly is the employer's own domain
 *   verified_employer_ats  an ATS board whose tenant matches the employer
 *   third_party            a job board/publisher, or another employer's ATS board
 *   unverified             not enough evidence to classify it either way
 *
 * What it never does: invent a URL, rewrite one, treat an unrecognised host as
 * official, or call a third-party a direct application. When there is no
 * evidence, the honest answer is `unverified`.
 */

/** The label shown for each kind. Kept here so UI and tests agree. */
export const SOURCE_LABELS: Record<JobSourceKind, string> = {
  official_company_site: "Official company careers",
  verified_employer_ats: "Verified employer ATS",
  third_party: "Third-party listing",
  unverified: "Destination not verified",
};

export type JobSource = {
  /** The link to open verbatim. Never modified. */
  url: string;
  /** The publisher the listing claimed, for the "via …" line. */
  publisher: string;
  kind: JobSourceKind;
  label: string;
  /** True only for an official employer domain or a verified employer ATS. */
  official: boolean;
  /** Human-readable reasons for the classification, for the report/tests. */
  evidence: string[];
  /** The destination's own name (ATS vendor or employer host), when known. */
  provider?: string;
};

export type DestinationClassification = {
  kind: JobSourceKind;
  label: string;
  official: boolean;
  evidence: string[];
  /**
   * The destination's own name, when it has one (the ATS vendor for an ATS, the
   * host for an employer page). Used for an honest "Apply via Workday" label;
   * absent when the destination has no verifiable provider.
   */
  provider?: string;
};

/** How an ATS encodes the company it belongs to. */
type AtsDefinition = {
  suffix: string;
  name: string;
  /** Where the tenant lives: a subdomain, a path segment, or either. */
  tenant: "subdomain" | "path" | "both";
};

/**
 * Applicant-tracking systems.
 *
 * Every entry is *recognised*, never *trusted*: the tenant still has to match
 * the employer before a link here is called a verified application.
 */
const ATS_SOURCES: readonly AtsDefinition[] = [
  { suffix: "greenhouse.io", name: "Greenhouse", tenant: "path" },
  { suffix: "lever.co", name: "Lever", tenant: "path" },
  { suffix: "ashbyhq.com", name: "Ashby", tenant: "path" },
  { suffix: "myworkdayjobs.com", name: "Workday", tenant: "subdomain" },
  { suffix: "workday.com", name: "Workday", tenant: "subdomain" },
  { suffix: "smartrecruiters.com", name: "SmartRecruiters", tenant: "path" },
  { suffix: "workable.com", name: "Workable", tenant: "path" },
  { suffix: "jobvite.com", name: "Jobvite", tenant: "path" },
  { suffix: "icims.com", name: "iCIMS", tenant: "subdomain" },
  { suffix: "successfactors.com", name: "SuccessFactors", tenant: "subdomain" },
  { suffix: "taleo.net", name: "Taleo", tenant: "subdomain" },
  { suffix: "bamboohr.com", name: "BambooHR", tenant: "subdomain" },
  { suffix: "recruitee.com", name: "Recruitee", tenant: "subdomain" },
  { suffix: "breezy.hr", name: "Breezy", tenant: "subdomain" },
  { suffix: "jazzhr.com", name: "JazzHR", tenant: "path" },
  { suffix: "rippling-ats.com", name: "Rippling", tenant: "both" },
  { suffix: "paylocity.com", name: "Paylocity", tenant: "subdomain" },
  { suffix: "ultipro.com", name: "UKG", tenant: "subdomain" },
  { suffix: "jobscore.com", name: "JobScore", tenant: "path" },
  { suffix: "applytojob.com", name: "ApplicantPro", tenant: "subdomain" },
  { suffix: "personio.de", name: "Personio", tenant: "subdomain" },
  { suffix: "personio.com", name: "Personio", tenant: "subdomain" },
  { suffix: "hire.withgoogle.com", name: "Google Hire", tenant: "path" },
];

/**
 * Job boards, aggregators, and republishers.
 *
 * A link here can still reach a real listing, so it is never discarded, but it
 * is classified as third-party and is *not* shown in the default official view.
 */
const THIRD_PARTY_SOURCES: readonly string[] = [
  "ziprecruiter.com",
  "ziprecruiter.de",
  "monster.com",
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "glassdoor.de",
  "glassdoor.co.uk",
  "glassdoor.co.in",
  "glassdoor.ca",
  "glassdoor.ie",
  "simplyhired.com",
  "simplyhired.de",
  "simplyhired.co.in",
  "simplyhired.co.uk",
  "careerjet.com",
  "careerjet.co.uk",
  "jooble.org",
  "jobleads.com",
  "bebee.com",
  "jobrapido.com",
  "stepstone.de",
  "jobijoba.de",
  "trabajo.org",
  "adzuna.com",
  "adzuna.de",
  "adzuna.in",
  "adzuna.co.uk",
  "xing.com",
  "naukri.com",
  "foundit.in",
  "bayt.com",
  "dice.com",
  "upwork.com",
  "learn4good.com",
  "jobsora.com",
  "jobted.com",
  "jobted.de",
  "jobteaser.com",
  "talent.com",
  "startup.jobs",
  "builtin.com",
  "tealhq.com",
  "jobright.ai",
  "jobgether.com",
  "remoterocketship.com",
  "remote-work.app",
  "arbeitsagentur.de",
  "arbeitnow.com",
  "jobilize.com",
  "salutemyjob.com",
  "whatjobs.com",
  "jobaaj.com",
  "simplify.jobs",
  "cutshort.io",
  "devsunite.com",
  "germantechjobs.de",
  "devjobs.de",
  "eurotoptech.com",
  "thesaasjobs.com",
  "jobmesh.io",
  "mygwork.com",
  "haystackapp.io",
  "lifeworq.com",
  "jobswarehouse.co.uk",
  "efinancialcareers.de",
  "hokify.de",
  "it-jobs.de",
  "stellenmarkt.de",
  "stellenmarkt.com",
  "karriere.com",
  "fashionjobs.com",
  "getmereferred.com",
  "niyukjobs.ai",
  "quickhyre.ai",
  "trueresume.ai",
  "olibr.com",
  "indianjob24h.in",
  "summerinternship2026.in",
  "studentinternships.org",
  "shine.com",
  "spacecrew.com",
  "djangojob.com",
  "lensa.com",
  "prosple.com",
  "talentify.io",
  "workvisajobs.co.uk",
  "findojobs.id",
  "remotepilot.dev",
  "jobriver.de",
  "jobsbylevel.com",
  "expatjobs.io",
  "digital-health-jobs.com",
  "bancalavoro.it",
  "hirethebetter.com",
  "jobsforces.net",
  "remotedach.de",
  "michaelpage.de",
  "michaelpage.com",
  "yer.de",
  "jobs.de",
  "jobware.de",
  "meinestadt.de",
  "jobboerse.de",
  "topstatecareers.com",
  "hiringmirror.com",
  "talent500.co",
  "jobrapido.co.in",
  "naukrimitra.in",
  "nbmbaa.org",
  "talents.vaia.com",
  "expertini.com",
];

/** Link shorteners: the destination is opaque, so it can never be verified. */
const SHORTENER_SOURCES: readonly string[] = [
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "is.gd",
  "shorturl.at",
  "lnkd.in",
  "rb.gy",
  "s.id",
  "t.ly",
  "short.io",
  "bl.ink",
  "tiny.cc",
  "shorte.st",
];

/** Hosts used by republishers/spam farms; safe to call third-party, never official. */
const SUSPICIOUS_SOURCES: readonly string[] = [
  "liveblog365.com",
  "html-5.me",
  "dedyn.io",
  "blogspot.com",
  "wordpress.com",
  "weebly.com",
  "wixsite.com",
  "github.io",
  "glitch.me",
];

const GENERIC_HOST_LABELS = new Set([
  "www",
  "jobs",
  "job",
  "careers",
  "career",
  "apply",
  "applyto",
  "boards",
  "job-boards",
  "job-boards",
  "my",
  "en",
  "us",
  "global",
  "hire",
  "hiring",
]);

/** Query parameters that wrap another URL, common on redirect endpoints. */
const REDIRECT_PARAMS = [
  "url",
  "u",
  "redirect",
  "redirect_uri",
  "redirect_url",
  "target",
  "dest",
  "destination",
  "link",
  "to",
  "continue",
  "goto",
  "out",
];

/** Lowercased hostname without a leading `www.`, or `null` for an unusable URL. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** True when `host` is exactly `suffix` or a subdomain of it. */
function matchesDomain(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function findDomain(host: string, suffixes: readonly string[]): string | null {
  for (const suffix of suffixes) {
    if (matchesDomain(host, suffix)) {
      return suffix;
    }
  }

  return null;
}

/**
 * Follows a redirect-style query parameter to the URL it wraps, when there is
 * one. This is how the *real* destination is judged instead of the wrapper, so a
 * legitimate employer redirect is not punished for its first hop.
 */
export function unwrapRedirect(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  for (const key of REDIRECT_PARAMS) {
    const value = parsed.searchParams.get(key);
    if (value !== null && /^https?:\/\//i.test(value)) {
      return value;
    }
  }

  const hash = parsed.hash.replace(/^#/, "");
  if (/^https?:\/\//i.test(hash)) {
    return hash;
  }

  return rawUrl;
}

/** Extracts candidate company tenants from an ATS URL. */
function atsTenants(host: string, pathname: string, ats: AtsDefinition): string[] {
  const candidates: string[] = [];

  if (ats.tenant === "subdomain" || ats.tenant === "both") {
    const suffixLabels = new Set(ats.suffix.split("."));
    for (const label of host.split(".")) {
      if (suffixLabels.has(label) || GENERIC_HOST_LABELS.has(label)) {
        continue;
      }
      if (/^wd\d+$/.test(label)) {
        continue;
      }
      candidates.push(label);
    }
  }

  if (ats.tenant === "path" || ats.tenant === "both") {
    const first = pathname.split("/").find((segment) => segment.length > 0);
    if (first !== undefined) {
      const decoded = decodeURIComponent(first).toLowerCase();
      if (!GENERIC_HOST_LABELS.has(decoded) && !/^[a-z]{2}([-_][a-z]{2})?$/.test(decoded)) {
        candidates.push(decoded);
      }
    }
  }

  return [...new Set(candidates)];
}

/**
 * A title-like hint from the URL path, when the board encodes the role there
 * (e.g. a Workday `/…/job/2027-Summer-Engineer-Intern_R000000` segment).
 */
function titleHintFromUrl(pathname: string): string | null {
  const segments = pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));

  for (const segment of segments.reverse()) {
    if (/^[a-z]{2}[-_][a-z]{2}$/i.test(segment) || /^\d+$/.test(segment)) {
      continue;
    }
    if (/\d/.test(segment) || /[-_]/.test(segment)) {
      const words = segment
        .replace(/\.[a-z]+$/i, "")
        .replace(/[_-]+/g, " ")
        .replace(/\b(r|l|req|job|id)\d+\b/gi, " ")
        .trim();
      if (words.split(/\s+/).filter((word) => word.length >= 3).length >= 2) {
        return words;
      }
    }
  }

  return null;
}

function isAcademicHost(host: string): boolean {
  return /(\.edu|\.ac\.[a-z]{2}|\.edu\.[a-z]{2})$/.test(host);
}

/**
 * Classifies a single destination URL.
 *
 * `company` is the advertised employer; `title` is optional and only used to add
 * a title-consistency note to the evidence, never to change the kind on its own.
 */
export function classifyDestination(
  url: string,
  company: string | undefined,
  title?: string
): DestinationClassification {
  const effective = unwrapRedirect(url);

  let parsed: URL;
  try {
    parsed = new URL(effective);
  } catch {
    return {
      kind: "unverified",
      label: SOURCE_LABELS.unverified,
      official: false,
      evidence: ["The link is not a usable URL."],
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "unverified",
      label: SOURCE_LABELS.unverified,
      official: false,
      evidence: ["The link is not a web URL."],
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const hasCompany = typeof company === "string" && company.trim().length > 0;

  // 1. A known board, republisher, or academic host is third-party even when the
  //    advertised employer happens to share its brand. Knowing the host is a
  //    board outranks any name resemblance, so a board listing "itself" is never
  //    promoted to an official company page.
  if (
    findDomain(host, THIRD_PARTY_SOURCES) !== null ||
    isAcademicHost(host) ||
    findDomain(host, SUSPICIOUS_SOURCES) !== null
  ) {
    return {
      kind: "third_party",
      label: SOURCE_LABELS.third_party,
      official: false,
      evidence: [`Host ${host} is a job board or publisher, not the employer.`],
    };
  }

  // 2. The employer's own domain, when we have an employer to compare against.
  if (hasCompany && employerMatchesHost(host, company)) {
    return {
      kind: "official_company_site",
      label: SOURCE_LABELS.official_company_site,
      official: true,
      evidence: [`Host ${host} matches the employer name "${company}".`],
      provider: host,
    };
  }

  // 3. A recognised ATS — verified only when its tenant belongs to the employer.
  const ats = findAts(host);
  if (ats !== null) {
    const tenants = atsTenants(host, parsed.pathname, ats);

    if (hasCompany && tenants.some((tenant) => tenantMatchesEmployer(tenant, company))) {
      const evidence = [
        `${ats.name} board "${tenants.join(", ")}" matches the employer "${company}".`,
      ];
      evidence.push(...titleEvidence(parsed.pathname, title));
      return {
        kind: "verified_employer_ats",
        label: SOURCE_LABELS.verified_employer_ats,
        official: true,
        evidence,
        provider: ats.name,
      };
    }

    if (!hasCompany) {
      return {
        kind: "unverified",
        label: SOURCE_LABELS.unverified,
        official: false,
        evidence: [`Hosted by ${ats.name}, but the listing names no employer to verify against.`],
      };
    }

    return {
      kind: "third_party",
      label: SOURCE_LABELS.third_party,
      official: false,
      evidence: [
        `Hosted by ${ats.name}, whose board does not match the employer "${company}".`,
      ],
    };
  }

  // 4. An opaque shortener cannot be verified. Checked before anything that
  //    could reward the wrapper, because the real destination is hidden.
  if (findDomain(host, SHORTENER_SOURCES) !== null) {
    return {
      kind: "unverified",
      label: SOURCE_LABELS.unverified,
      official: false,
      evidence: [`Host ${host} is a link shortener; the destination is opaque.`],
    };
  }

  // 5. Unknown host: insufficient evidence to call it official.
  return {
    kind: "unverified",
    label: SOURCE_LABELS.unverified,
    official: false,
    evidence: [`Host ${host} is unrecognised and cannot be tied to the employer.`],
  };
}

function findAts(host: string): AtsDefinition | null {
  for (const ats of ATS_SOURCES) {
    if (matchesDomain(host, ats.suffix)) {
      return ats;
    }
  }

  return null;
}

/**
 * The ATS vendor a host belongs to, or `null`.
 *
 * Recognition only — this says nothing about whether the board belongs to a
 * given employer. Discovery uses it to tell "an ATS posting for somebody else"
 * apart from "an unknown host".
 */
export function knownAtsName(host: string): string | null {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  return findAts(normalized)?.name ?? null;
}

function titleEvidence(pathname: string, title: string | undefined): string[] {
  if (typeof title !== "string" || title.trim().length === 0) {
    return [];
  }

  const hint = titleHintFromUrl(pathname);
  if (hint === null || titlesAreConsistent(title, hint)) {
    return [];
  }

  return [`The URL names a different role ("${hint}") than "${title}".`];
}

function rankOf(kind: JobSourceKind): number {
  switch (kind) {
    case "official_company_site":
      return 4;
    case "verified_employer_ats":
      return 3;
    case "third_party":
      return 2;
    default:
      return 1;
  }
}

/**
 * The best destination for a job, or `null` when the listing offered none.
 *
 * Candidates are every `applyOptions` entry plus the normalized `applyUrl` if it
 * is not already among them (older stored scans may carry only the single link).
 * Ranking is by evidence, not familiarity: an official employer page beats a
 * verified ATS, which beats a third-party board, which beats an unknown host.
 * Ties keep the order the listing supplied.
 */
export function selectJobSource(job: NormalizedJob): JobSource | null {
  const options: ApplyOption[] = [];

  if (job.applyOptions !== undefined) {
    options.push(...job.applyOptions);
  }

  if (job.applyUrl !== undefined && !options.some((option) => option.url === job.applyUrl)) {
    options.push({ publisher: job.applyUrlPublisher ?? "Apply", url: job.applyUrl });
  }

  let best: JobSource | null = null;
  let bestRank = Number.NEGATIVE_INFINITY;

  for (const option of options) {
    const classification = classifyDestination(option.url, job.company, job.title);
    const rank = rankOf(classification.kind);

    if (rank > bestRank) {
      best = { url: option.url, publisher: option.publisher, ...classification };
      bestRank = rank;
    }
  }

  if (best !== null) {
    return best;
  }

  if (job.googleJobsUrl !== undefined) {
    return {
      url: job.googleJobsUrl,
      publisher: "Google Jobs",
      kind: "unverified",
      label: SOURCE_LABELS.unverified,
      official: false,
      evidence: ["The listing supplied no application link; this is Google's original listing."],
    };
  }

  return null;
}

/** The classification of a job's best destination, defaulting to `unverified`. */
export function jobSourceKind(job: NormalizedJob): JobSourceKind {
  return selectJobSource(job)?.kind ?? "unverified";
}

/** True only when a job's best destination is an employer-owned/verified source. */
export function isOfficialJob(job: NormalizedJob): boolean {
  return selectJobSource(job)?.official ?? false;
}
