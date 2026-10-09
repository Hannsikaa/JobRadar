/**
 * The shape of a job the app is willing to show.
 *
 * This is the *normalized* job, not the SerpApi payload. Raw `jobs_results`
 * entries are inconsistent by nature — salary sometimes sits in
 * `detected_extensions`, sometimes in `extensions`, posted time is relative text
 * rather than a timestamp — so nothing above this layer is allowed to know that
 * SerpApi exists. Everything downstream (deduplication, matching, the API
 * response, the UI) reads this type.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **Nothing is invented.** A field is absent when the source did not provide
 *    it. There is no placeholder salary, no guessed posting date, no synthesized
 *    company name.
 * 2. **Derived values carry their own evidence.** `isFresh`, `detectedExperienceLevel`,
 *    `relevanceScore` and `relevanceReasons` are computed, never copied from a
 *    single raw field, so a reader can always ask what they were computed from.
 */

/** Career level, as the profile already models it. */
export type ExperienceLevel = "internship" | "entry" | "junior" | "mid" | "senior";

/**
 * How trustworthy a job's apply destination is.
 *
 * `official_company_site` and `verified_employer_ats` are the only two that may
 * be called a verified application; `third_party` is a board or publisher, and
 * `unverified` means there was not enough evidence to say. Assigned by
 * `apply-source.ts` from the URL, the employer name, and the ATS tenant.
 */
export type JobSourceKind =
  | "official_company_site"
  | "verified_employer_ats"
  | "third_party"
  | "unverified";

/**
 * Where a job physically came from.
 *
 * "Google Jobs" is the search transport. The others are employer ATS boards read
 * directly through their public posting APIs. The label is display-only: the
 * trust of the apply destination is still decided by `apply-source.ts` from the
 * URL and the verified tenant, never from this string.
 */
export type JobDiscoverySource = "Google Jobs" | "Greenhouse" | "Lever" | "Ashby";

/**
 * The outcome of one direct employer-board query during a scan.
 *
 * Recorded per board so the coverage disclosure can say which boards answered,
 * which had nothing, and which were unreachable, instead of implying that every
 * employer was checked successfully.
 */
export type DirectSourceReport = {
  /** ATS platform, e.g. "greenhouse". */
  platform: string;
  /** The board token, exactly as read from the employer's own link. */
  tenant: string;
  /** The employer name the listing advertised. */
  employer: string;
  /** How the board responded. */
  status: "ok" | "empty" | "not_found" | "rate_limited" | "unavailable" | "malformed";
  /** Public postings the board returned in total. */
  returned: number;
  /**
   * Postings that matched a target role and were merged into the scan. Measured
   * before the freshness and salary filters, so it can exceed the number visible.
   */
  matched: number;
};

/**
 * The outcome of one bounded official-careers discovery attempt.
 *
 * Only the two `verified_*` outcomes may be attached as a destination. Every
 * other value is a reason the listing keeps its original (unverified or
 * third-party) destination. The union is stored on the job so the card can say
 * what was actually checked instead of implying a check that never happened.
 */
export type OfficialDiscoveryStatus =
  | "verified_official_job"
  | "verified_employer_ats_job"
  | "employer_found_no_job"
  | "employer_mismatch"
  | "role_mismatch"
  | "location_mismatch"
  | "no_employer_domain"
  | "provider_error";

/**
 * What the official-careers check concluded for one listing.
 *
 * `resolvedAt` is the honest "last checked" date, not a claim that the page was
 * ever fetched: discovery compares search-provider results, it does not crawl.
 */
export type OfficialDiscoverySummary = {
  status: OfficialDiscoveryStatus;
  /** Reasons generated from the actual outcome. Never fixed reassurance. */
  evidence: string[];
  /** ISO timestamp of when this destination was resolved. */
  resolvedAt: string;
};

/**
 * A salary as printed on the listing, plus the numbers that could be read out of
 * it.
 *
 * `min`/`max` are in the listing's own currency and period, exactly as written.
 * No conversion is performed: a listing in a different currency than the user's
 * preference is kept, and simply not comparable.
 */
export type NormalizedSalary = {
  /** The text as Google printed it, always shown to the user verbatim. */
  text: string;
  min?: number;
  max?: number;
  currency?: string;
  /** Omitted when the text did not say. */
  period?: "hour" | "day" | "week" | "month" | "year";
};

/** One way to reach the listing, as offered by the source. */
export type ApplyOption = {
  /** Publisher name, e.g. "LinkedIn". */
  publisher: string;
  url: string;
};

/** Posting age, read from Google Jobs' relative text. */
export type PostedAge = {
  /** Days since posting. `0` for "today"/"just posted". */
  days: number;
  /** The original text, e.g. "4 days ago". Never rewritten. */
  text: string;
};

/** A job, normalized, deduplicated, scored, and known to the discovery history. */
export type NormalizedJob = {
  /**
   * Stable identity for this listing.
   *
   * `serpapi:<job_id>` when SerpApi supplied a job id, otherwise `fp:<fingerprint>`.
   * Deterministic: the same listing produces the same id on every scan, which is
   * what makes "new since last scan" honest.
   */
  id: string;
  /** The deterministic fingerprint, always present, even when `job_id` was used. */
  fingerprint: string;
  /** SerpApi's job id when it supplied one. */
  serpapiJobId?: string;

  title: string;
  /**
   * Employer name. Optional on purpose: Google omits it often enough that
   * inventing "Unknown Company" would put a fake name into the fingerprint and
   * into deduplication, where it would collide with every other anonymous job.
   */
  company?: string;
  /** As printed by Google, e.g. "Hyderabad, Telangana, India". */
  location?: string;
  /** Google's own "via" publisher, e.g. "LinkedIn". Not the aggregator we used. */
  publisher?: string;
  /**
   * How this job was found: the search transport ("Google Jobs") or the employer
   * ATS board it was read from directly ("Greenhouse", "Lever", "Ashby").
   */
  source: JobDiscoverySource;
  thumbnailUrl?: string;

  description?: string;
  highlights?: { title: string; items: string[] }[];

  salary?: NormalizedSalary;
  /** Posting age, when Google exposed one. Absent means "not stated". */
  posted?: PostedAge;
  /** Remote, when the listing said so. Absent means "not stated". */
  isRemote?: boolean;
  scheduleType?: string;

  /**
   * Best available link to the job: a direct apply option when one exists,
   * otherwise Google's share link.
   */
  applyUrl?: string;
  /** Which publisher `applyUrl` points at. */
  applyUrlPublisher?: string;
  /** Google's own share link, when present. */
  googleJobsUrl?: string;
  /** Every apply option the listing offered. */
  applyOptions?: ApplyOption[];

  /**
   * The outcome of the bounded official-careers check for this listing, when it
   * ran for this scan. Absent means "not checked" (discovery disabled, or a scan
   * stored before the feature existed) — never "failed verification".
   */
  officialDiscovery?: OfficialDiscoverySummary;

  /**
   * The verified source chosen for the Apply button, stored so a scan's evidence
   * survives in the database. Optional because older scans predate the field and
   * the UI recomputes the selection deterministically when it is absent.
   */
  applySourceKind?: JobSourceKind;
  applySourceLabel?: string;
  /** True only for an official employer domain or a verified employer ATS. */
  applySourceVerified?: boolean;
  selectedApplyUrl?: string;
  applySourceEvidence?: string[];

  /** Level inferred from the listing's own wording. Absent means "not stated". */
  detectedExperienceLevel?: ExperienceLevel;

  /** Posted within the user's freshness window, or the age is unknown. */
  isFresh: boolean;
  /** Not present in this user's discovery history before this scan. */
  isNew: boolean;
  /** 0–100, deterministic and explainable. See `matching.ts` for the weights. */
  relevanceScore: number;
  /** One line per signal that actually fired. Never generic filler. */
  relevanceReasons: string[];

  /** The target role this job was found for, and the location that was searched. */
  matchedRole?: string;
  searchedLocation?: string;
};

/** What one SerpApi request contributed, for the scan summary and the UI caption. */
export type SearchAttempt = {
  query: string;
  location?: string;
  role?: string;
  ok: boolean;
  resultCount: number;
  /** Present only when `ok` is false. Safe to show; never contains credentials. */
  error?: string;
};

/** Aggregate counts for a completed scan. */
export type JobSearchMetadata = {
  /** Jobs after normalization and deduplication. */
  total: number;
  /** How many are within the user's freshness window. */
  freshCount: number;
  /** How many were not seen in any previous scan. */
  newCount: number;
  /** How many listed a salary. */
  salaryKnownCount: number;
  /** How many were dropped because a known salary was below the minimum. */
  belowMinimumCount: number;
  /** How many had no readable posting age, so freshness could not be judged. */
  unknownAgeCount: number;

  searchedRoles: string[];
  searchedLocations: string[];
  /** SerpApi requests actually issued for this scan. */
  searchCount: number;
  /** Requests that failed. Non-zero with a non-empty `jobs` is a partial result. */
  failedSearchCount: number;
  /** Raw `jobs_results` entries received before normalization. */
  rawCount: number;
  /** Entries removed as duplicates. */
  duplicateCount: number;

  /**
   * How many employer ATS boards were queried this scan. Absent on scans
   * recorded before employer-board discovery existed.
   */
  directSourceBoards?: number;
  /**
   * How many employer-board postings are in the final result, after the
   * freshness and salary filters. The per-board `directSources[].matched` counts
   * are taken earlier, so their sum can be larger.
   */
  directSourcePostings?: number;
  /** Per-board outcomes, for the search-coverage disclosure. */
  directSources?: DirectSourceReport[];

  freshnessDays: number;
  experienceLevel: ExperienceLevel;
  /** ISO timestamp of when the scan finished. */
  scannedAt: string;
  /**
   * False when the discovery history could not be read or written, so `isNew`
   * means "unknown" rather than a claim.
   */
  newTrackingAvailable: boolean;
};

/** The complete result of one scan. */
export type JobSearchResult = {
  jobs: NormalizedJob[];
  metadata: JobSearchMetadata;
  attempts: SearchAttempt[];
};