/**
 * Errors for the job-search pipeline.
 *
 * The route turns these into HTTP responses, so every message here is written
 * for a person reading it in a browser. Nothing in this module ever carries a
 * SerpApi API key, a MongoDB URI, a raw driver error, or a SerpApi response
 * body: those stay in `cause` for the server log.
 *
 * The `code` is what callers branch on. Messages are for humans and may be
 * reworded; codes are the contract.
 */

/**
 * Why a search could not be completed.
 *
 * - `profile_not_found` — the caller has no profile, so there is nothing to
 *   search for. Not retryable without a profile.
 * - `target_roles_missing` — the profile exists but the person has not chosen
 *   any target roles. This is an unanswered question, not "no jobs".
 * - `locations_missing` — same for locations.
 * - `serpapi_not_configured` — no `SERPAPI_API_KEY` on the server.
 * - `serpapi_failed` — every SerpApi request for this scan failed.
 * - `serpapi_rate_limited` — SerpApi refused the requests for quota reasons.
 * - `serpapi_unavailable` — network failure or a 5xx from SerpApi.
 * - `serpapi_malformed_response` — SerpApi answered with something that is not a
 *   Google Jobs payload.
 * - `discovery_store_unavailable` — the discovery history could not be read or
 *   written, so "new since last scan" cannot be answered truthfully.
 */
export type JobSearchErrorCode =
  | "profile_not_found"
  | "target_roles_missing"
  | "locations_missing"
  | "serpapi_not_configured"
  | "serpapi_failed"
  | "serpapi_rate_limited"
  | "serpapi_unavailable"
  | "serpapi_malformed_response"
  | "discovery_store_unavailable";

/** Default HTTP status per code. A caller can override it where it knows better. */
const STATUS_BY_CODE: Record<JobSearchErrorCode, number> = {
  profile_not_found: 404,
  target_roles_missing: 400,
  locations_missing: 400,
  serpapi_not_configured: 503,
  serpapi_failed: 502,
  serpapi_rate_limited: 429,
  serpapi_unavailable: 502,
  serpapi_malformed_response: 502,
  discovery_store_unavailable: 503,
};

export class JobSearchError extends Error {
  readonly code: JobSearchErrorCode;
  readonly status: number;

  constructor(code: JobSearchErrorCode, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "JobSearchError";
    this.code = code;
    this.status = options?.status ?? STATUS_BY_CODE[code];
  }
}

/**
 * Whether a failure is the caller's own configuration rather than ours.
 *
 * Used to pick a log level: an unanswered question about target roles is normal,
 * a SerpApi outage is not.
 */
export function isUserConfigurationError(error: JobSearchError): boolean {
  return (
    error.code === "profile_not_found" ||
    error.code === "target_roles_missing" ||
    error.code === "locations_missing"
  );
}