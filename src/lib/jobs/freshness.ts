import type { PostedAge } from "@/lib/jobs/types";
import { normalizeWhitespace } from "@/lib/jobs/text";

/**
 * Posting age from Google Jobs' relative text.
 *
 * Google Jobs does not return a posting timestamp. It returns human text —
 * "Just posted", "4 days ago", "22 days ago", "30+ days ago", sometimes nothing
 * at all. So freshness is computed as *an age in whole days*, never as a
 * fabricated ISO timestamp: a posting day is a day-resolution fact, and inventing
 * 14:03:22 for it would be a lie that later reads as precision.
 *
 * When the text cannot be understood, `parsePostedAge` returns `null` and the job
 * carries no `posted` field at all. The caller then treats freshness as unknown
 * rather than assuming either "today" or "too old".
 */

/** Anything older than this is reported as unknown rather than as a huge number. */
const MAX_TRACKED_DAYS = 365;

const JUST_POSTED = new Set(["just posted", "posted today", "today", "new", "hours ago", "an hour ago", "just now", "moments ago"]);

/**
 * Reads a relative posted-time string.
 *
 * Returns the original text alongside the age so the UI can show Google's own
 * wording. A listing that says "30+ days ago" yields `30` — the lower bound it
 * states — and `approximate: true`, because "+" means the real number is higher.
 */
export function parsePostedAge(raw: string | undefined | null): PostedAge | null {
  if (typeof raw !== "string") {
    return null;
  }

  const text = normalizeWhitespace(raw).toLowerCase();
  if (text.length === 0) {
    return null;
  }

  if (JUST_POSTED.has(text)) {
    return { days: 0, text };
  }

  // "3 hours ago" / "an hour ago": younger than a day, so age 0.
  if (/\b(hour|minute|min)\b/.test(text) && !/\bday\b/.test(text)) {
    return { days: 0, text };
  }

  const relative = text.match(/(\d+)\s*(day|week|month|year)/);
  if (relative !== null) {
    const amount = Number.parseInt(relative[1], 10);
    const unit = relative[2] as "day" | "week" | "month" | "year";
    const days = toDays(amount, unit);

    if (days !== null) {
      return { days, text };
    }
  }

  // "yesterday" is one day old and needs no number to say so.
  if (/^yesterday$/.test(text)) {
    return { days: 1, text };
  }

  // "last week", "last month": a lower bound with no exact count.
  if (/^last\s+week$/.test(text)) {
    return { days: 7, text };
  }

  if (/^last\s+month$/.test(text)) {
    return { days: 30, text };
  }

  return null;
}

/**
 * Converts a count of calendar units to days.
 *
 * Months and years are rounded down to whole days using the shortest plausible
 * span for each, so a value never claims to be fresher than it can be:
 * a month is treated as 28 days and a year as 365.
 */
function toDays(amount: number, unit: "day" | "week" | "month" | "year"): number | null {
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const perUnit: Record<typeof unit, number> = {
    day: 1,
    week: 7,
    month: 28,
    year: 365,
  };

  const days = Math.round(amount * perUnit[unit]);

  // Past the tracking horizon there is nothing useful to say, so it is reported
  // as "so old we cannot judge" instead of a number that would sort as fresh on
  // some future boundary condition.
  return days > MAX_TRACKED_DAYS ? null : days;
}

/** The supported freshness windows. Mirrors the profile schema. */
export const FRESHNESS_WINDOWS = [1, 3, 7, 14] as const;
export type FreshnessWindow = (typeof FRESHNESS_WINDOWS)[number];

/** Clamps an arbitrary number onto a supported window. */
export function toFreshnessWindow(value: number): FreshnessWindow {
  const match = FRESHNESS_WINDOWS.find((window) => window === value);
  return match ?? 7;
}

/**
 * Whether a job counts as fresh for the user's window.
 *
 * `posted === null` — the listing did not say — returns `false`: an unknown
 * age is never presented as fresh. Retention is a separate question (see
 * `isWithinFreshnessWindow`), so a job with no known posting date stays in
 * the results without ever claiming to be inside the window.
 */
export function isFreshForWindow(
  posted: PostedAge | null,
  freshnessDays: number
): boolean {
  if (posted === null) {
    return false;
  }

  return posted.days <= freshnessDays;
}

/**
 * Retention predicate: should the job survive the freshness filter at all?
 *
 * Unknown dates are kept here (they may be perfectly current listings — Google
 * simply did not say), while `isFreshForWindow` above refuses to badge them.
 * The two are deliberately separate so "we don't know" never becomes either
 * "too old" (job hidden) or "fresh" (job mislabelled).
 */
export function isWithinFreshnessWindow(
  posted: PostedAge | null,
  freshnessDays: number
): boolean {
  if (posted === null) {
    return true;
  }

  return posted.days <= freshnessDays;
}

/** "2 days ago" → "2d". A compact caption for dense cards. */
export function formatPostedAgeShort(posted: PostedAge | null): string | undefined {
  if (posted === null) {
    return undefined;
  }

  if (posted.days === 0) {
    return "today";
  }

  if (posted.days === 1) {
    return "1d";
  }

  return `${posted.days}d`;
}