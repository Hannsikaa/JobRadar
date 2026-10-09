/**
 * Small, total readers for untrusted ATS payloads.
 *
 * ATS responses are external data: fields move, types change, entries go
 * missing. Nothing here throws — an unreadable value becomes `undefined`, and a
 * caller skips the entry rather than inventing a field.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trimmed, whitespace-collapsed non-empty string, or `undefined`. */
export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** A string or a finite number as a string id (ATS ids come as both). */
export function readId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return readString(value);
}

/** The first readable string in an array, or `undefined`. */
export function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    const text = readString(item);
    if (text !== undefined) {
      return text;
    }
  }

  return undefined;
}

/** Converts a number of milliseconds or a date string into an ISO string. */
export function readTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }

  return undefined;
}

/** True when `host` is exactly `suffix` or a subdomain of it. */
export function matchesHost(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Path segments that are structural, not a tenant token. Skipped when reading a
 * board token out of a URL so `/v1/boards/acme/jobs` still yields `acme`.
 */
export const GENERIC_PATH_SEGMENTS = new Set([
  "boards",
  "board",
  "embed",
  "v1",
  "v2",
  "api",
  "job-boards",
  "jobs",
  "job",
  "companies",
  "company",
  "postings",
  "posting",
  "en",
]);

/**
 * The first plausible board token in a URL path, or `undefined`.
 *
 * Lowercased and restricted to the characters ATS tokens actually use, so a
 * numeric job id or a locale segment is never mistaken for a tenant.
 */
export function boardTokenFromPath(pathname: string): string | undefined {
  for (const raw of pathname.split("/")) {
    if (raw.length === 0) {
      continue;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(raw).toLowerCase();
    } catch {
      return undefined;
    }

    if (GENERIC_PATH_SEGMENTS.has(decoded)) {
      continue;
    }

    if (decoded.length < 2 || !/^[a-z0-9][a-z0-9._-]*$/.test(decoded)) {
      return undefined;
    }

    return decoded;
  }

  return undefined;
}
