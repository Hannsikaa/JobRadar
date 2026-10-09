import type { JobPreferences, ResumeProfile } from "@/lib/profile/types";
import {
  describeExperienceLevel,
  detectExperienceLevel,
  levelCompatibility,
} from "@/lib/jobs/experience";
import { isExcludedByExperienceLevel } from "@/lib/jobs/experience-filter";
import { isFreshForWindow } from "@/lib/jobs/freshness";
import { DEFAULT_FLOOR_PERIOD, salaryMeetsMinimum, type SalaryFloor } from "@/lib/jobs/salary";
import type { ExperienceLevel, NormalizedJob } from "@/lib/jobs/types";
import { joinPhrases, matchTerms, normalizeWhitespace } from "@/lib/jobs/text";

/**
 * Deterministic relevance scoring.
 *
 * No model, no embeddings, no external service. Every job gets a 0–100 number
 * built from six weighted signals plus reasons that name the signal that fired.
 * The weights are fixed constants below, not learned and not tuned — a score here
 * means "these signals matched", never "a classifier is 84% confident".
 *
 * The design rule throughout: **a weak match cannot buy a high score.** Each
 * signal saturates at its own weight, so even a perfect score on one dimension
 * leaves the rest of the 100 unclaimed.
 */

/** Maximum points per signal. They sum to 100. */
export const RELEVANCE_WEIGHTS = {
  /** Target-role agreement with the job title. */
  role: 35,
  /** Overlap between profile skills/technologies and the listing text. */
  skills: 25,
  /** Location agreement with the user's saved locations. */
  location: 12,
  /** Career-level agreement. */
  experience: 12,
  /** Inside the requested freshness window. */
  freshness: 10,
  /** Known salary meets the stated minimum. */
  salary: 6,
} as const;

/** What the scorer reads out of the profile. */
export type RelevanceContext = {
  resume: Pick<ResumeProfile, "skills" | "technologies" | "projects" | "experience">;
  preferences: Pick<
    JobPreferences,
    "targetRoles" | "locations" | "experienceLevel" | "freshnessDays" | "minimumSalary" | "salaryCurrency"
  >;
  /** Now, injected so the scorer is a pure function and tests are deterministic. */
  now?: Date;
};

/**
 * The skills and technologies worth matching against.
 *
 * Profile `skills` and `technologies` are merged and deduplicated
 * case-insensitively, keeping the profile's own spelling for the reason text.
 */
function profileTerms(resume: RelevanceContext["resume"]): string[] {
  const seen = new Map<string, string>();

  for (const term of [...resume.skills, ...resume.technologies]) {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, trimmed);
    }
  }

  return [...seen.values()];
}

/**
 * Technologies mentioned in the user's projects and roles.
 *
 * Distinct from `profileTerms`: these are things they have demonstrably built
 * with, so a hit is worth slightly more than a hit on a claimed skill.
 */
function experienceTerms(resume: RelevanceContext["resume"]): string[] {
  const terms: string[] = [];

  for (const project of resume.projects ?? []) {
    terms.push(...(project.technologies ?? []));
  }

  for (const role of resume.experience ?? []) {
    if (role.description !== undefined) {
      terms.push(role.description);
    }
  }

  return terms.filter((term) => term.trim().length >= 2);
}

/** Everything about a job that text matching may look at. */
function searchableText(job: NormalizedJob): string {
  return normalizeWhitespace(
    [
      job.title,
      job.company ?? "",
      job.location ?? "",
      job.description ?? "",
      job.scheduleType ?? "",
      ...(job.highlights ?? []).flatMap((group) => [group.title, ...group.items]),
    ].join(" ")
  );
}

/**
 * Scores one job and attaches the reasons that produced the score.
 *
 * Mutating is avoided: the input job is spread into a new object, so the caller
 * can keep the un-scored version for diagnostics.
 */
export function scoreJob(
  job: NormalizedJob,
  context: RelevanceContext
): NormalizedJob {
  const { preferences, resume } = context;
  const text = searchableText(job);
  const reasons: string[] = [];

  // --- Role -----------------------------------------------------------------
  // The strongest single signal: a target role appearing in the title. Matched
  // against the whole listing too, at a reduced weight, because "Backend
  // Developer" sometimes appears in the body while the title says
  // "Software Engineer II".
  const titleText = normalizeWhitespace(job.title);
  const titleMatches = matchTerms(titleText, preferences.targetRoles);
  const bodyMatches =
    titleMatches.length === 0 ? matchTerms(text, preferences.targetRoles) : [];

  if (titleMatches.length > 0) {
    reasons.push(`Matches your target role: ${joinPhrases(titleMatches)}`);
  } else if (bodyMatches.length > 0) {
    reasons.push(`Target role mentioned: ${joinPhrases(bodyMatches)}`);
  }

  const rolePoints =
    titleMatches.length > 0
      ? RELEVANCE_WEIGHTS.role
      : bodyMatches.length > 0
        ? RELEVANCE_WEIGHTS.role * 0.4
        : 0;

  // --- Skills ---------------------------------------------------------------
  const skillMatches = matchTerms(text, profileTerms(resume));
  const demonstratedMatches = matchTerms(text, experienceTerms(resume));

  if (skillMatches.length > 0) {
    reasons.push(`Matches ${skillMatches.length} of your skills (${joinPhrases(skillMatches.slice(0, 4))})`);
  }

  if (demonstratedMatches.length > 0) {
    reasons.push(`Uses technology from your background: ${joinPhrases(demonstratedMatches.slice(0, 3))}`);
  }

  /**
   * Saturating: five skills is full marks, one is a fifth. Experience evidence
   * is worth a third of a skill hit on top, so a stack someone has shipped is
   * worth more than a stack they have only listed.
   */
  const skillPoints =
    Math.min(skillMatches.length / 5, 1) * RELEVANCE_WEIGHTS.skills +
    Math.min(demonstratedMatches.length / 5, 1) * (RELEVANCE_WEIGHTS.skills / 3);

  // --- Location -------------------------------------------------------------
  const locationMatches = matchLocations(job, preferences.locations);
  if (locationMatches.state === "match") {
    reasons.push(`Located in ${locationMatches.label}`);
  } else if (locationMatches.state === "remote") {
    reasons.push("Remote, which matches your remote preference");
  }

  const locationPoints = locationMatches.state === "none" ? 0 : RELEVANCE_WEIGHTS.location;

  // --- Experience -----------------------------------------------------------
  const detected =
    job.detectedExperienceLevel ?? detectExperienceLevel(text) ?? null;
  const compatibility = levelCompatibility(detected, preferences.experienceLevel as ExperienceLevel);

  if (compatibility === 1 && detected !== null) {
    reasons.push(`Fits your ${describeExperienceLevel(detected)} preference`);
  } else if (compatibility === 0.5 && detected !== null) {
    reasons.push(`One step from your ${describeExperienceLevel(preferences.experienceLevel as ExperienceLevel)} preference`);
  }

  const experiencePoints = compatibility === null ? 0 : compatibility * RELEVANCE_WEIGHTS.experience;

  // --- Freshness ------------------------------------------------------------
  const fresh = isFreshForWindow(job.posted ?? null, preferences.freshnessDays);
  if (job.posted !== undefined) {
    reasons.push(
      job.posted.days === 0 ? "Posted today" : `Posted ${describeDays(job.posted.days, job.posted.text)}`
    );
  }

  const freshnessPoints = fresh ? RELEVANCE_WEIGHTS.freshness : 0;

  // --- Salary ---------------------------------------------------------------
  // The floor is annual unless the caller says otherwise: the profile stores a
  // bare amount and a currency, and "minimum salary" conventionally means a
  // yearly one. A listing in another currency or period stays uncompared rather
  // than being converted or guessed at.
  const floor: SalaryFloor | undefined =
    preferences.minimumSalary === undefined || (preferences.salaryCurrency ?? "").length === 0
      ? undefined
      : {
          amount: preferences.minimumSalary,
          currency: preferences.salaryCurrency as string,
          period: DEFAULT_FLOOR_PERIOD,
        };
  const meets = salaryMeetsMinimum(job.salary, floor);

  let salaryPoints = 0;
  if (meets === true) {
    salaryPoints = RELEVANCE_WEIGHTS.salary;
    reasons.push(`Listed salary meets your ${floor?.amount} ${floor?.currency} minimum`);
  } else if (meets === false) {
    reasons.push(`Listed salary is below your ${floor?.amount} ${floor?.currency} minimum`);
  }

  const score = clamp(
    rolePoints +
      skillPoints +
      locationPoints +
      experiencePoints +
      freshnessPoints +
      salaryPoints
  );

  return {
    ...job,
    ...(detected === null ? {} : { detectedExperienceLevel: detected }),
    isFresh: fresh,
    relevanceScore: Math.round(score),
    relevanceReasons: reasons,
  };
}

/**
 * Scores a batch and orders it best-first.
 *
 * Ordering is by score, then by freshness (newer wins a tie), then by title so
 * the order is stable across identical scores — a list that reshuffles between two
 * identical scans looks like a bug to the user.
 */
export function scoreJobs(
  jobs: readonly NormalizedJob[],
  context: RelevanceContext
): NormalizedJob[] {
  const wantedLevel = context.preferences.experienceLevel as ExperienceLevel;

  // When the user has selected a experience level, remove jobs that directly
  // contradict it. This is applied before scoring so excluded jobs do not
  // receive any relevance points at all.
  const filtered = wantedLevel !== "mid"
    ? jobs.filter((job) => !isExcludedByExperienceLevel(
        job.title || "",
        wantedLevel
      ))
    : jobs;

  const scored = filtered.map((job) => scoreJob(job, context));

  return scored.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }

    const aDays = a.posted?.days ?? Number.MAX_SAFE_INTEGER;
    const bDays = b.posted?.days ?? Number.MAX_SAFE_INTEGER;
    if (aDays !== bDays) {
      return aDays - bDays;
    }

    return a.title.localeCompare(b.title);
  });
}

/** Where a job sits relative to the user's saved locations. */
type LocationMatch =
  | { state: "match"; label: string }
  | { state: "remote"; label: string }
  | { state: "none"; label: string };

/**
 * Compares a job location against the user's locations.
 *
 * A remote preference counts as a match even for a named location, because a
 * remote listing satisfies "I want remote work" regardless of where Google says
 * the job sits.
 */
function matchLocations(job: NormalizedJob, wanted: readonly string[]): LocationMatch {
  if (wanted.length === 0) {
    return { state: "none", label: job.location ?? "" };
  }

  const jobLocation = normalizeWhitespace(job.location ?? "").toLowerCase();

  if (job.isRemote === true || /\bremote\b|\bwork from home\b|\banywhere\b/i.test(jobLocation)) {
    return { state: "remote", label: jobLocation };
  }

  for (const candidate of wanted) {
    const needle = normalizeWhitespace(candidate).toLowerCase();
    if (needle.length === 0) {
      continue;
    }

    if (jobLocation === needle) {
      return { state: "match", label: candidate };
    }

    // A saved "Hyderabad, India" matches a listed "Hyderabad, Telangana, India"
    // on the city alone. Comparing the leading segment is what makes a
    // one-word-per-city match work without prefix-matching arbitrary strings.
    const needleCity = needle.split(",")[0];
    const jobCity = jobLocation.split(",")[0];

    if (needleCity.length >= 3 && jobCity.length >= 3 && needleCity === jobCity) {
      return { state: "match", label: candidate };
    }

    if (jobLocation.includes(needle)) {
      return { state: "match", label: candidate };
    }
  }

  return { state: "none", label: job.location ?? "" };
}

/** "2 days ago" is clearer than "2d" in a sentence. */
function describeDays(days: number, fallbackText: string): string {
  if (days === 1) {
    return "1 day ago";
  }

  if (fallbackText.trim().length > 0) {
    return fallbackText;
  }

  return `${days} days ago`;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}
