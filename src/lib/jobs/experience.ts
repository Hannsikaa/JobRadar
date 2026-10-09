import type { ExperienceLevel } from "@/lib/jobs/types";

/**
 * Inferring a career level from a listing's own words.
 *
 * Google Jobs has no experience-level filter that Job Radar can rely on, so the
 * level is read from the text the listing already contains — title first,
 * description and schedule type after. This is a *hint for scoring*, never a
 * filter: a listing with no recognizable level is not excluded, it simply has no
 * level evidence either way.
 *
 * Only levels that actually appear in postings are recognized. "mid" is
 * deliberately absent from the positive patterns: almost nobody writes "mid-level
 * engineer" in a title, and matching the bare substring "mid" would fire on
 * "midnight", "mid-sized", and "mid-career" by accident. "mid" is instead
 * inferred as the absence of a junior or senior signal, which is what a reader
 * would conclude from the same title.
 */

/** Words that indicate each level, longest and most specific first. */
const LEVEL_PATTERNS: { level: Exclude<ExperienceLevel, "mid">; patterns: RegExp[] }[] = [
  {
    level: "internship",
    patterns: [
      /\bintern(?:ship)?\b/i,
      /\binterns?\b/i,
      /\bco-?op\b/i,
      /\btrainee\b/i,
      /\bapprentice(?:ship)?\b/i,
      /\bstudent\b/i,
      /\bgraduate program\b/i,
      /\binternship program\b/i,
    ],
  },
  {
    level: "entry",
    patterns: [
      /\bentry[\s-]?level\b/i,
      /\bnew grad(?:uate)?\b/i,
      /\bgraduate (?:role|position|engineer|program)\b/i,
      /\bjunior\b/i,
      /\bassociate\b/i,
      /\bapprentice\b/i,
      /\b0\s*-\s*2\s*years?\b/i,
      /\b(?:zero|0)\s*to\s*2\s*years?\b/i,
      /\bfresher\b/i,
    ],
  },
  {
    level: "senior",
    patterns: [
      /\bsenior\b/i,
      /\bsr\.?\b/i,
      /\blead\b/i,
      /\bprincipal\b/i,
      /\bstaff\b/i,
      /\barchitect\b/i,
      /\bdirector\b/i,
      /\bhead of\b/i,
      /\bmanager\b/i,
      /\bvp\b/i,
      /\bchief\b/i,
      /\biii\b/i,
      /\biv\b/i,
      /\bexpert\b/i,
    ],
  },
];

/**
 * Detects the level a listing advertises.
 *
 * Returns `null` when nothing matches, meaning "not stated". Callers must not
 * convert `null` into a level: an unstated level is a fact about the listing.
 */
export function detectExperienceLevel(text: string): ExperienceLevel | null {
  if (text.trim().length === 0) {
    return null;
  }

  for (const { level, patterns } of LEVEL_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return level;
      }
    }
  }

  return null;
}

/**
 * How well a listing's stated level matches the level the user is aiming at.
 *
 * Returns a value in `[0, 1]`:
 *
 * - `1.0` — the listing states exactly the level sought.
 * - `0.5` — adjacent (entry↔junior, junior↔mid, mid↔senior). A one-step
 *   mismatch is a real signal but not a disqualification.
 * - `0.0` — two or more steps apart (internship vs senior).
 * - `null` — the listing states no level, so there is nothing to compare and the
 *   signal is omitted from the score entirely. This is the important case: an
 *   unstated level must not be scored as a mismatch, or every listing without a
 *   level keyword would be pushed down.
 */
export function levelCompatibility(
  stated: ExperienceLevel | null,
  wanted: ExperienceLevel
): number | null {
  if (stated === null) {
    return null;
  }

  const order: ExperienceLevel[] = ["internship", "entry", "junior", "mid", "senior"];
  const distance = Math.abs(order.indexOf(stated) - order.indexOf(wanted));

  if (distance === 0) {
    return 1;
  }

  if (distance === 1) {
    return 0.5;
  }

  return 0;
}

/**
 * Whether two levels are compatible enough to keep a job in the result set.
 *
 * Used only for the extreme case: a user looking for internships should not be
 * shown a principal role as a match. Everything within one step is kept — the
 * score communicates the difference, and a single keyword in a description is too
 * weak a signal to hide a job on.
 */
export function isLevelCompatible(
  stated: ExperienceLevel | null,
  wanted: ExperienceLevel
): boolean {
  const compatibility = levelCompatibility(stated, wanted);

  return compatibility === null || compatibility >= 0.5;
}

/** Human phrasing for a level, used in relevance reasons. */
export function describeExperienceLevel(level: ExperienceLevel): string {
  switch (level) {
    case "internship":
      return "internship";
    case "entry":
      return "entry-level";
    case "junior":
      return "junior";
    case "mid":
      return "mid-level";
    case "senior":
      return "senior";
  }
}