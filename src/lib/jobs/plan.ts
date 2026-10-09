import { toFreshnessWindow } from "@/lib/jobs/freshness";
import type { ExperienceLevel } from "@/lib/jobs/types";
import { normalizeWhitespace } from "@/lib/jobs/text";

/**
 * Turning a profile into a bounded list of SerpApi queries.
 *
 * SerpApi is a metered API and every call costs money, so the plan is
 * deliberately explicit about its own ceiling rather than discovering it at
 * runtime. The rule this module encodes:
 *
 *   **N locations × M target roles, capped at {@link MAX_SEARCHES} total, with
 *   roles taking priority when the cap bites.**
 *
 * Priority order matters. A user with three roles in two locations who cannot
 * afford all six searches is better served by a broad role sweep in one location
 * than by two roles in three locations — the roles are what they are looking for,
 * and the location is a filter they can relax.
 *
 * Every search targets exactly one role in exactly one location. A single query
 * trying to express three roles with OR would return broader, less relevant results
 * and would not tell us which role a result actually matched, which the
 * `matchedRole` field depends on.
 */

/** Hard ceiling on SerpApi requests per workflow run. */
export const MAX_SEARCHES = 6;

/** Maximum target roles searched. Beyond this the tail is dropped, not merged. */
export const MAX_ROLES = 4;

/** Maximum locations searched. */
export const MAX_LOCATIONS = 3;

/** One query: a single role, a single location. */
export interface PlannedSearch {
  /** Free-text query, already including level and remote qualifiers. */
  q: string;
  /** Location passed to SerpApi's `location` parameter, verbatim from the profile. */
  location?: string;
  /** The target role this query is for. */
  role?: string;
}

/** The full plan plus what it intentionally left out. */
export interface SearchPlan {
  searches: PlannedSearch[];
  /** Roles actually searched, in order. */
  roles: string[];
  /** Locations actually searched, in order. */
  locations: string[];
  /** Roles skipped because the search cap was hit. */
  skippedRoles: string[];
  /** Locations skipped because the search cap was hit. */
  skippedLocations: string[];
}

/**
 * Maps each experience level to a query qualifier.
 *
 * These are words people put in job titles and descriptions, not an API filter:
 * Google Jobs has no experience-level parameter, so the level is expressed as
 * part of the query text and reinforced by post-processing. `mid` gets no
 * qualifier because "mid" in a query string matches nothing useful and adds noise.
 */
const LEVEL_QUERY_TERMS: Record<ExperienceLevel, string | null> = {
  internship: "internship",
  entry: "entry level",
  junior: "junior",
  mid: null,
  senior: "senior",
};

/**
 * Maps the profile's job types to a query qualifier.
 *
 * Only one qualifier is used even when several types are selected: adding
 * "full-time part-time contract" to a query produces postings for all three at
 * once, which is worse than picking the most specific one.
 */
function jobTypeTerm(jobTypes: readonly string[], experienceLevel: ExperienceLevel): string | null {
  // An internship preference is already expressed by the level qualifier.
  if (experienceLevel === "internship") {
    return null;
  }

  for (const type of jobTypes) {
    const normalized = type.trim().toLowerCase();
    if (normalized.length === 0) {
      continue;
    }

    if (normalized === "full-time" || normalized === "part time" || normalized === "part-time") {
      return normalized.replace("-", " ");
    }

    if (normalized === "contract") {
      return "contract";
    }
  }

  return null;
}

/**
 * Builds the bounded search plan for a profile.
 *
 * Returns an empty `searches` array when the profile has no target roles or no
 * locations. The caller treats that as a configuration question to put to the
 * user, not as "zero results found".
 */
export function buildSearchPlan(input: {
  targetRoles: readonly string[];
  locations: readonly string[];
  experienceLevel: ExperienceLevel;
  jobTypes?: readonly string[];
  remoteOnly?: boolean;
}): SearchPlan {
  const roles = dedupeStrings(input.targetRoles).slice(0, MAX_ROLES);
  const locations = dedupeStrings(input.locations).slice(0, MAX_LOCATIONS);

  if (roles.length === 0 || locations.length === 0) {
    return { searches: [], roles, locations, skippedRoles: [], skippedLocations: [] };
  }

  const levelTerm = LEVEL_QUERY_TERMS[input.experienceLevel];
  const typeTerm = jobTypeTerm(input.jobTypes ?? [], input.experienceLevel);
  const remoteTerm = input.remoteOnly === true ? "remote" : null;

  const searches: PlannedSearch[] = [];
  const usedLocations = new Set<string>();
  const usedRoles = new Set<string>();
  const skippedRoles: string[] = [];
  const skippedLocations: string[] = [];

  // Roles first: iterate roles in the outer loop so the cap truncates locations
  // (the more relaxable dimension) before it truncates roles.
  for (const role of roles) {
    let placed = false;

    for (const location of locations) {
      if (searches.length >= MAX_SEARCHES) {
        break;
      }

      searches.push({
        q: buildQuery(role, [levelTerm, typeTerm, remoteTerm]),
        location,
        role,
      });
      usedRoles.add(role);
      usedLocations.add(location);
      placed = true;
    }

    if (!placed) {
      skippedRoles.push(role);
    }
  }

  for (const location of locations) {
    if (!usedLocations.has(location)) {
      skippedLocations.push(location);
    }
  }

  return {
    searches,
    roles: [...usedRoles],
    locations: [...usedLocations],
    skippedRoles,
    skippedLocations,
  };
}

/** One query string: the role, then any qualifiers. Never repeats a term. */
function buildQuery(role: string, qualifiers: (string | null)[]): string {
  const parts = [role];
  const seen = new Set<string>();

  for (const qualifier of qualifiers) {
    if (qualifier === null) {
      continue;
    }

    const token = qualifier.trim().toLowerCase();
    if (token.length === 0 || seen.has(token)) {
      continue;
    }

    // A qualifier already present in the role adds nothing.
    if (role.toLowerCase().includes(token)) {
      continue;
    }

    seen.add(token);
    parts.push(qualifier.trim());
  }

  return parts.join(" ");
}

/** Trims, drops blanks, and removes case-insensitive duplicates. */
function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = normalizeWhitespace(value);
    if (trimmed.length === 0) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

/**
 * The freshness window in words, for a reason line or a caption.
 *
 * Not used to build the query: the freshness window is applied as a post-filter
 * against the posting age, because a `q` qualifier for recency narrows results in
 * ways that vary by location and quietly hides valid jobs.
 */
export function describeFreshness(days: number): string {
  const window = toFreshnessWindow(days);

  return window === 1 ? "the last day" : `the last ${window} days`;
}