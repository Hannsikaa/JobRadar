/**
 * Text helpers shared by normalization, matching, and deduplication.
 *
 * All of them are total functions: any input, including empty strings and
 * unexpected shapes, produces a usable answer. SerpApi payloads are external
 * data and are treated as untrusted, so nothing here throws.
 */

/** Lowercases and collapses whitespace. Used before any comparison. */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * A comparable form of a job or company name.
 *
 * Lowercased, punctuation removed, whitespace collapsed. "Acme, Inc." and
 * "acme inc" compare equal, which is what a human means when they read two
 * listings from different aggregators and call them the same job.
 */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Word tokens of length two or more.
 *
 * Single characters are dropped because they match everywhere ("c", "go", "r")
 * and would inflate overlap counts for every posting. Punctuation is treated as
 * a separator, so `node.js` yields `node` and `js`, which is how listings
 * actually spell it.
 */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

/** Strips a protocol, `www.`, and a trailing slash so URLs compare sensibly. */
export function normalizeUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * A stable, URL-safe 40-bit hash.
 *
 * Used only for building a short fingerprint from already-stable text. It is
 * deliberately not cryptographic: it exists so the same listing yields the same
 * id on every scan and across processes, which is what "new since last scan"
 * depends on. FNV-1a is used because it is a few lines, dependency-free, and
 * stable across Node versions.
 */
export function hashText(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // 32-bit FNV prime multiply, kept in uint32 range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36).padStart(7, "0");
}

/**
 * Whether `text` contains `phrase` as a whole-word phrase.
 *
 * Word-boundary matching on both sides, so "go" does not match "google" and
 * "python" does not match "pythonista". Prevents the most common way a keyword
 * scorer quietly lies.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const haystack = normalizeWhitespace(text).toLowerCase();
  const needle = normalizeWhitespace(phrase).toLowerCase();

  if (needle.length === 0) {
    return false;
  }

  if (needle.includes(" ")) {
    return haystack.includes(needle);
  }

  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`, "u").test(
    haystack,
  );
}

/** Escapes a string for literal use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Counts how many of `candidates` appear in `text` as whole words.
 *
 * Returns the matches themselves, so callers can name the skills that fired
 * rather than only counting them — the difference between a reason a user can
 * check and a bare number.
 */
export function matchTerms(text: string, candidates: readonly string[]): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    if (containsPhrase(text, trimmed)) {
      seen.add(key);
      matches.push(trimmed);
    }
  }

  return matches;
}

/** Joins a list into "a, b, and c" — used only in human-readable reasons. */
export function joinPhrases(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }

  if (values.length === 1) {
    return values[0];
  }

  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

/** Truncates for a short caption without cutting mid-word when avoidable. */
export function truncate(value: string, maxLength: number): string {
  const trimmed = normalizeWhitespace(value);
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const cut = trimmed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");

  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}