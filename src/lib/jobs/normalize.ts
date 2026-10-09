import type { SerpApiJobResult } from "@/lib/serpapi/client";
import { parsePostedAge } from "@/lib/jobs/freshness";
import { parseSalary } from "@/lib/jobs/salary";
import type { ApplyOption, NormalizedJob } from "@/lib/jobs/types";
import { hashText, normalizeName, normalizeUrl, normalizeWhitespace } from "@/lib/jobs/text";

/**
 * Turning a SerpApi `jobs_results` entry into a {@link NormalizedJob}.
 *
 * The raw payload is inconsistent: salary can be in `detected_extensions` or in
 * `extensions`, posted time can be `detected_extensions.posted_at` or a bare
 * "4 days ago" string somewhere in `extensions`, and any of it can be absent.
 * Normalization therefore *reads from several places and keeps whichever it
 * finds*, and leaves a field absent when it finds none.
 *
 * Nothing is defaulted to a plausible-looking value. An absent company stays
 * absent rather than becoming "Unknown Company", because that string would then
 * be treated as a real company name by deduplication and by the fingerprint.
 */

export type NormalizeContext = {
  /**
   * Apply link to fall back on when the listing offers none, e.g. a Google share
   * link. Kept out of the raw job so the caller decides what a valid link is.
   */
  shareLinkFallback?: string;
};

/**
 * Normalizes one raw result.
 *
 * Returns `null` only when the entry cannot be a job at all — which, in practice,
 * means it has no title. A title-less entry cannot be identified, deduplicated,
 * or shown, so dropping it is the honest option; everything else is preserved
 * even if sparse.
 */
export function normalizeJob(
  raw: SerpApiJobResult,
  context: NormalizeContext = {}
): NormalizedJob | null {
  const title = firstString(raw.title);
  if (title === null) {
    return null;
  }

  const company = firstString(raw.company_name);
  const location = firstString(raw.location);
  const publisher = firstString(raw.via);
  const description = firstString(raw.description);
  const thumbnailUrl = firstString(raw.thumbnail);

  const salaryText = salarySourceText(raw);
  const salary = parseSalary(salaryText);

  const posted = parsePostedAge(postedSourceText(raw));
  const remote = readRemoteFlag(raw);

  const applyOptions = readApplyOptions(raw);
  const shareLink = firstString(raw.share_link) ?? context.shareLinkFallback ?? null;

  // A direct apply option is preferred over Google's share link: it takes the
  // user to the employer's own posting rather than an aggregator's page.
  const preferred = applyOptions[0];

  const highlights = readHighlights(raw);
  const scheduleType = firstString(raw.detected_extensions?.schedule_type);

  const fingerprint = buildFingerprint({ title, company, location, url: preferred?.url ?? shareLink });
  const serpapiJobId = firstString(raw.job_id);

  return {
    id: serpapiJobId === null ? `fp:${fingerprint}` : `serpapi:${serpapiJobId}`,
    fingerprint,
    ...(serpapiJobId === null ? {} : { serpapiJobId }),
    title,
    ...(company === null ? {} : { company }),
    ...(location === null ? {} : { location }),
    ...(publisher === null ? {} : { publisher }),
    source: "Google Jobs",
    ...(thumbnailUrl === null ? {} : { thumbnailUrl }),
    ...(description === null ? {} : { description }),
    ...(highlights.length === 0 ? {} : { highlights }),
    ...(salary === null ? {} : { salary }),
    ...(posted === null ? {} : { posted }),
    ...(remote === null ? {} : { isRemote: remote }),
    ...(scheduleType === null ? {} : { scheduleType }),
    ...(preferred !== undefined ? { applyUrl: preferred.url, applyUrlPublisher: preferred.publisher } : {}),
    ...(shareLink === null ? {} : { googleJobsUrl: shareLink }),
    ...(applyOptions.length === 0 ? {} : { applyOptions }),
    // Set by the scoring pass, which is the only thing that has a profile to
    // compare against. Placeholders here would be lies if that pass were skipped.
    isFresh: false,
    isNew: false,
    relevanceScore: 0,
    relevanceReasons: [],
  };
}

/** Normalizes a batch, dropping entries that are not jobs. */
export function normalizeJobs(
  raw: readonly SerpApiJobResult[],
  context: NormalizeContext = {}
): NormalizedJob[] {
  const jobs: NormalizedJob[] = [];

  for (const entry of raw) {
    const normalized = normalizeJob(entry, context);
    if (normalized !== null) {
      jobs.push(normalized);
    }
  }

  return jobs;
}

/**
 * The identity of a listing, independent of which aggregator served it.
 *
 * Combines normalized title, company, location, and the direct URL. All four,
 * because each is load-bearing:
 *
 * - title alone collapses genuinely different jobs at the same company;
 * - adding company and location separates those;
 * - the URL separates two postings that share a title, company, and location but
 *   are different requisitions.
 *
 * Missing fields contribute an empty segment rather than being omitted, so a job
 * without a location cannot collide with one whose location happens to be blank.
 */
export function buildFingerprint(parts: {
  title: string;
  company: string | null;
  location: string | null;
  url: string | null;
}): string {
  const canonical = [
    normalizeName(parts.title),
    normalizeName(parts.company ?? ""),
    normalizeName(parts.location ?? ""),
    parts.url === null ? "" : normalizeUrl(parts.url),
  ].join("|");

  return hashText(canonical);
}

/**
 * Reads the salary string from wherever Google put it.
 *
 * `detected_extensions.salary` is the structured field and is preferred.
 * Otherwise the `extensions` array is scanned for a string that looks like money,
 * because that is where it lands when detection fails.
 */
function salarySourceText(raw: SerpApiJobResult): string | null {
  const detected = firstString(raw.detected_extensions?.salary);
  if (detected !== null) {
    return detected;
  }

  for (const entry of raw.extensions ?? []) {
    const candidate = firstString(entry);
    if (candidate !== null && looksLikeSalary(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Reads posted time from `detected_extensions.posted_at`, falling back to a
 * scan of `extensions` for the "N days ago" style string.
 */
function postedSourceText(raw: SerpApiJobResult): string | null {
  const detected = firstString(raw.detected_extensions?.posted_at);
  if (detected !== null) {
    return detected;
  }

  for (const entry of raw.extensions ?? []) {
    const candidate = firstString(entry);
    if (candidate !== null && looksLikePostedTime(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Remote is only reported when Google said so explicitly. */
function readRemoteFlag(raw: SerpApiJobResult): boolean | null {
  const flag = raw.detected_extensions?.work_from_home;
  if (typeof flag === "boolean") {
    return flag;
  }

  return null;
}

/** Every apply option, in Google's order, with the publisher name preserved. */
function readApplyOptions(raw: SerpApiJobResult): ApplyOption[] {
  const options: ApplyOption[] = [];

  for (const option of raw.apply_options ?? []) {
    const url = firstString(option.link);
    if (url === null) {
      continue;
    }

    options.push({ publisher: firstString(option.title) ?? "Apply", url });
  }

  return options;
}

/** Highlights with at least one item; an empty group is noise, not information. */
function readHighlights(raw: SerpApiJobResult): { title: string; items: string[] }[] {
  const groups: { title: string; items: string[] }[] = [];

  for (const group of raw.job_highlights ?? []) {
    const items = (group.items ?? []).filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );

    if (items.length === 0) {
      continue;
    }

    groups.push({ title: firstString(group.title) ?? "Highlights", items });
  }

  return groups;
}

/** A trimmed non-empty string, or `null`. The only string reader used. */
function firstString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = normalizeWhitespace(value);
  return trimmed.length === 0 ? null : trimmed;
}

function looksLikeSalary(value: string): boolean {
  return /[$€£₹¥]|\b(?:usd|inr|eur|gbp|aed|cad|aud|sgd|hkd|chf)\b/i.test(value);
}

function looksLikePostedTime(value: string): boolean {
  return /\b(\d+\s*(?:hour|minute|day|week|month|year)s?\s*ago|yesterday|today|just posted|last\s+(?:week|month))\b/i.test(
    value
  );
}