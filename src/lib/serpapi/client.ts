import { getServerEnv } from "@/lib/env";

/**
 * SerpApi Google Jobs client.
 *
 * Server-side only. `SERPAPI_API_KEY` is read through `getServerEnv()` (which
 * throws if it is ever evaluated in a browser) and is put on the wire and
 * nowhere else: it is never logged, never returned, and never placed in an error
 * message or a `cause` that reaches the client.
 *
 * The response types below are deliberately loose. SerpApi adds fields without
 * notice and omits optional ones without warning, so every field a caller reads
 * is declared optional except the ones a Google Jobs result always carries, and
 * `searchGoogleJobs` validates the envelope rather than trusting it.
 */

/** The engine Job Radar uses. There is no other engine in this codebase. */
export const GOOGLE_JOBS_ENGINE = "google_jobs";

/**
 * The web-search engine, used only by official-careers discovery.
 *
 * Google Jobs is the discovery transport; this is a separate, bounded lookup
 * used to locate an employer's own job page or employer-specific ATS posting.
 * It exists so discovery never has to guess a career URL from a company name.
 */
export const GOOGLE_ENGINE = "google";

/** Request parameters for one Google Jobs search. */
export interface SerpApiSearchParams {
  /** Free-text query. Built by `@/lib/jobs/plan`. */
  q: string;
  /** City-level location, e.g. "Hyderabad, India". Never invented. */
  location?: string;
  /** Interface language. */
  hl?: string;
  /** Country bias for results. */
  gl?: string;
  /** Google domain to query. */
  google_domain?: string;
  /** Token from `serpapi_pagination`, for the next page. */
  next_page_token?: string;
  /** Bypass SerpApi's cache. Off by default: freshness of *results* matters more. */
  no_cache?: boolean;
}

/** A job as SerpApi returns it. Only `title` is guaranteed. */
export interface SerpApiJobResult {
  job_id?: string;
  title?: string;
  company_name?: string;
  location?: string;
  via?: string;
  share_link?: string;
  thumbnail?: string;
  /** Short highlights, including the posted-time and salary strings. */
  extensions?: string[];
  detected_extensions?: {
    posted_at?: string;
    salary?: string;
    schedule_type?: string;
    qualifications?: string;
    work_from_home?: boolean;
    health_insurance?: boolean;
    dental_coverage?: boolean;
    paid_time_off?: boolean;
  };
  description?: string;
  job_highlights?: Array<{ title?: string; items?: string[] }>;
  apply_options?: Array<{ title?: string; link?: string }>;
}

/** The response envelope. Everything but `search_metadata` is treated as optional. */
export interface SerpApiSearchResponse {
  search_metadata?: {
    id?: string;
    status?: string;
    created_at?: string;
    processed_at?: string;
    google_jobs_url?: string;
    total_time_taken?: number;
  };
  search_parameters?: {
    q?: string;
    engine?: string;
    location?: string;
    google_domain?: string;
  };
  jobs_results?: SerpApiJobResult[];
  filters?: SerpApiFilter[];
  serpapi_pagination?: {
    next_page_token?: string;
    next?: string;
  };
}

/** A filter group Google offered, e.g. "Date posted". Kept for UI options. */
export interface SerpApiFilter {
  name?: string;
  options?: Array<{ name?: string; parameters?: { uds?: string; q?: string } }>;
}

/** Request parameters for one web search used by official-careers discovery. */
export interface SerpApiWebParams {
  q: string;
  /** Country bias for results. */
  gl?: string;
  /** Interface language. */
  hl?: string;
  /** City-level location, e.g. "Hyderabad, India". Never invented. */
  location?: string;
  /** Requested organic result count. Google caps this near ten. */
  num?: number;
}

/** One organic web result. Only `link` is ever treated as a candidate. */
export interface SerpApiWebResult {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  displayed_link?: string;
}

/** The web-search envelope. Everything but `search_metadata` is optional. */
export interface SerpApiWebResponse {
  search_metadata?: {
    id?: string;
    status?: string;
  };
  organic_results?: SerpApiWebResult[];
  error?: string;
}

/** Why a SerpApi call failed, in terms the caller can branch on. */
export type SerpApiErrorKind =
  | "not_configured"
  | "rate_limited"
  | "unavailable"
  | "malformed_response"
  | "bad_request";

/**
 * A SerpApi failure with a *safe* message.
 *
 * The provider's own error text is kept in `detail` for the server log and is
 * never surfaced to a client: provider messages can echo the request, and the
 * request carries the API key.
 */
export class SerpApiError extends Error {
  readonly kind: SerpApiErrorKind;
  /** HTTP status to answer with. Never derived from a provider body. */
  readonly status: number;
  /** Server-side only. Must not reach a response body. */
  readonly detail?: unknown;

  constructor(
    kind: SerpApiErrorKind,
    message: string,
    status: number,
    detail?: unknown
  ) {
    super(message);
    this.name = "SerpApiError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/** Default timeout for one SerpApi request. SerpApi is normally a few seconds. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Runs one Google Jobs search.
 *
 * Rejects with a {@link SerpApiError} for every failure mode: no key configured,
 * HTTP failure, provider-reported error, or a body that is not a Google Jobs
 * payload. It never returns a partially-trusted object — if `jobs_results` is
 * missing, the result is an empty list, which is a valid answer meaning "no
 * results", not a crash.
 */
export async function searchGoogleJobs(
  params: SerpApiSearchParams
): Promise<SerpApiSearchResponse> {
  const { SERPAPI_API_KEY, SERPAPI_BASE_URL } = getServerEnv();

  if (SERPAPI_API_KEY === undefined) {
    throw new SerpApiError(
      "not_configured",
      "Job search is not configured on this server.",
      503
    );
  }

  const query = params.q.trim();
  if (query.length === 0) {
    throw new SerpApiError("bad_request", "A search query is required.", 400);
  }

  const searchParams = new URLSearchParams({
    engine: GOOGLE_JOBS_ENGINE,
    api_key: SERPAPI_API_KEY,
    q: query,
    hl: params.hl ?? "en",
    gl: params.gl ?? "us",
    google_domain: params.google_domain ?? "google.com",
  });

  // `location` is the documented way to scope a Google Jobs search. A location is
  // never also appended to `q`: doing both narrows the query for no benefit and
  // makes the query text unreadable in SerpApi's own logs.
  if (params.location !== undefined && params.location.trim().length > 0) {
    searchParams.set("location", params.location.trim());
  }

  if (params.next_page_token !== undefined && params.next_page_token.length > 0) {
    searchParams.set("next_page_token", params.next_page_token);
  }

  if (params.no_cache === true) {
    searchParams.set("no_cache", "true");
  }

  const url = `${SERPAPI_BASE_URL.replace(/\/+$/, "")}/search.json?${searchParams.toString()}`;

  // Only the path and query, with the key stripped. `redactUrl` exists so a
  // future debug log can never leak the credential by interpolating `url`.
  const safeUrl = redactUrl(url);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    throw new SerpApiError(
      "unavailable",
      "The job search provider could not be reached.",
      502,
      { url: safeUrl, cause: String(error) }
    );
  }

  const body = await readJsonBody(response, safeUrl);

  if (!response.ok) {
    const kind: SerpApiErrorKind = isRateLimited(response.status, body) ? "rate_limited" : "unavailable";
    throw new SerpApiError(
      kind,
      kind === "rate_limited"
        ? "The job search provider has no capacity left right now. Try again shortly."
        : "The job search provider rejected the request.",
      kind === "rate_limited" ? 429 : 502,
      { status: response.status, body: redactBody(body), url: safeUrl }
    );
  }

  // SerpApi reports several failures inside a 200 body — but it also reports a
  // *legitimate empty answer* the same way: google_jobs answers "no results"
  // with `error: "Google hasn't returned any results for this query."` while
  // `search_metadata.status` says the search itself succeeded. That is a real
  // answer ("nothing matched"), not a failure, and turning it into a 502 would
  // tell the user the provider broke when it simply found nothing.
  if (hasProviderError(body) && !isEmptyJobsResult(body)) {
    throw new SerpApiError(
      isRateLimitedBody(body) ? "rate_limited" : "bad_request",
      "The job search provider reported an error for this search.",
      isRateLimitedBody(body) ? 429 : 502,
      { body: redactBody(body), url: safeUrl }
    );
  }

  if (!isGoogleJobsPayload(body)) {
    throw new SerpApiError(
      "malformed_response",
      "The job search provider returned an unexpected response.",
      502,
      { url: safeUrl }
    );
  }

  return body;
}

/**
 * Follows `next_page_token` up to a hard page limit.
 *
 * Bounded on purpose: pagination is useful for filling out a small result set,
 * but an unbounded loop against a metered API is not something a user-facing
 * button should be able to trigger. `maxPages` is clamped to
 * `MAX_PAGES_PER_SEARCH` so no caller can exceed the budget, and a page that
 * fails ends the walk with the pages already fetched rather than discarding them.
 */
export async function searchGoogleJobsPages(
  params: SerpApiSearchParams,
  maxPages: number
): Promise<{ jobs: SerpApiJobResult[]; pagesFetched: number }> {
  const limit = Math.min(Math.max(Math.trunc(maxPages), 1), MAX_PAGES_PER_SEARCH);

  const jobs: SerpApiJobResult[] = [];
  let token = params.next_page_token;
  let pagesFetched = 0;

  for (let page = 0; page < limit; page += 1) {
    const response = await searchGoogleJobs(
      token === undefined ? params : { ...params, next_page_token: token }
    );

    jobs.push(...(response.jobs_results ?? []));
    pagesFetched += 1;

    token = response.serpapi_pagination?.next_page_token;
    if (token === undefined || token.length === 0) {
      break;
    }
  }

  return { jobs, pagesFetched };
}

/**
 * Runs one Google web search, used only to locate an employer's official job
 * page or employer-specific ATS posting.
 *
 * Deliberately one page and one query: this is an enrichment lookup, not a
 * crawl. It shares the credential handling of {@link searchGoogleJobs} — the key
 * goes on the wire and nowhere else — and rejects with a {@link SerpApiError} so
 * the caller can treat a discovery failure as non-fatal.
 */
export async function searchWeb(params: SerpApiWebParams): Promise<SerpApiWebResponse> {
  const { SERPAPI_API_KEY, SERPAPI_BASE_URL } = getServerEnv();

  if (SERPAPI_API_KEY === undefined) {
    throw new SerpApiError("not_configured", "Job search is not configured on this server.", 503);
  }

  const query = params.q.trim();
  if (query.length === 0) {
    throw new SerpApiError("bad_request", "A search query is required.", 400);
  }

  const searchParams = new URLSearchParams({
    engine: GOOGLE_ENGINE,
    api_key: SERPAPI_API_KEY,
    q: query,
    hl: params.hl ?? "en",
    gl: params.gl ?? "us",
    google_domain: "google.com",
  });

  if (params.location !== undefined && params.location.trim().length > 0) {
    searchParams.set("location", params.location.trim());
  }

  if (params.num !== undefined) {
    const bounded = Math.min(Math.max(Math.trunc(params.num), 1), 10);
    searchParams.set("num", String(bounded));
  }

  const url = `${SERPAPI_BASE_URL.replace(/\/+$/, "")}/search.json?${searchParams.toString()}`;
  const safeUrl = redactUrl(url);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new SerpApiError("unavailable", "The web search provider could not be reached.", 503, {
      url: safeUrl,
    });
  }

  const body = await readJsonBody(response, safeUrl);

  if (!response.ok) {
    const limited = response.status === 429 || mentionsQuota(body);
    throw new SerpApiError(
      limited ? "rate_limited" : "unavailable",
      limited
        ? "The web search provider has no capacity left right now."
        : "The web search provider rejected the request.",
      limited ? 429 : 503,
      { status: response.status, url: safeUrl }
    );
  }

  if (!isWebPayload(body)) {
    throw new SerpApiError(
      "malformed_response",
      "The web search provider returned an unexpected response.",
      502,
      { url: safeUrl }
    );
  }

  // A provider `error` with no successful empty result is a real failure. A
  // genuine no-results search is a valid answer and returns an empty list.
  if (
    typeof body.error === "string" &&
    body.error.trim().length > 0 &&
    !isEmptyWebResult(body)
  ) {
    if (mentionsQuota(body)) {
      throw new SerpApiError(
        "rate_limited",
        "The web search provider has no capacity left right now.",
        429,
        { url: safeUrl }
      );
    }

    throw new SerpApiError("bad_request", "The web search provider returned an error.", 502, {
      url: safeUrl,
    });
  }

  return body;
}

/** Confirms a body looks like a Google web result before anything reads it. */
function isWebPayload(body: unknown): body is SerpApiWebResponse {
  if (typeof body !== "object" || body === null) {
    return false;
  }

  const candidate = body as SerpApiWebResponse;

  return Array.isArray(candidate.organic_results) || typeof candidate.search_metadata === "object";
}

/** True when a provider `error` means "zero results", not "something broke". */
function isEmptyWebResult(body: SerpApiWebResponse): boolean {
  if (typeof body.error !== "string") {
    return false;
  }

  const noResultsWording = /hasn'?t returned any results|no results|did not match/i.test(body.error);
  return noResultsWording && body.search_metadata?.status === "Success";
}

/**
 * Hard ceiling on pages per search.
 *
 * Google Jobs returns roughly ten results per page, so two pages is twenty
 * listings per query — enough that a second page is worth a request, and small
 * enough that a single workflow run stays in single-digit request territory.
 */
export const MAX_PAGES_PER_SEARCH = 2;

/**
 * Strips the API key from a URL so it is safe to log.
 *
 * Replaces the *value* of `api_key` rather than the whole parameter, so the log
 * still shows which engine and location were queried — which is the entire point
 * of debugging a search.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.searchParams.has("api_key")) {
      parsed.searchParams.set("api_key", "REDACTED");
    }

    return parsed.toString();
  } catch {
    // A URL we cannot parse must not reach a log with a key in it.
    return url.includes("api_key") ? "https://serpapi.com/search.json?api_key=REDACTED" : url;
  }
}

/**
 * Removes anything key-shaped from a provider body before it is logged.
 *
 * SerpApi echoes the request in some error payloads. Retaining the body at all
 * is a diagnostic convenience; this is what keeps that convenience from becoming
 * a credential leak.
 */
function redactBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  const entries = Object.entries(body as Record<string, unknown>);
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    if (/api[_-]?key/i.test(key)) {
      sanitized[key] = "REDACTED";
      continue;
    }

    sanitized[key] =
      typeof value === "string" && /api_key=[^&\s]+/i.test(value)
        ? value.replace(/api_key=[^&\s]+/gi, "api_key=REDACTED")
        : value;
  }

  return sanitized;
}

/** Reads the body as JSON, turning a parse failure into a malformed-response error. */
async function readJsonBody(response: Response, safeUrl: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SerpApiError(
      "malformed_response",
      "The job search provider returned an unreadable response.",
      502,
      { status: response.status, url: safeUrl }
    );
  }
}

/** SerpApi signals quota problems with these status codes. */
function isRateLimited(status: number, body: unknown): boolean {
  return status === 429 || (status === 401 && mentionsQuota(body));
}

/** Some quota failures arrive as 200 with an `error` string. */
function isRateLimitedBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && mentionsQuota(body);
}

function mentionsQuota(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }

  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && /quota|rate limit|too many requests|searches per/i.test(error);
}

/** True when the provider put an `error` in a 200 response. */
function hasProviderError(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }

  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error.trim().length > 0;
}

/**
 * True when the `error` means "zero results", not "something broke".
 *
 * Two signals must agree: the provider's own no-results wording, and
 * `search_metadata.status === "Success"` — which is SerpApi saying the search
 * ran to completion. A real provider error (bad key, blocked, malformed) never
 * carries a successful search status, so it still throws.
 */
function isEmptyJobsResult(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }

  const candidate = body as { error?: unknown; search_metadata?: { status?: unknown } };
  if (typeof candidate.error !== "string") {
    return false;
  }

  const noResultsWording = /hasn'?t returned any results|no results/i.test(candidate.error);
  const searchSucceeded = candidate.search_metadata?.status === "Success";

  return noResultsWording && searchSucceeded;
}

/**
 * Confirms the body looks like a Google Jobs result before anything reads it.
 *
 * Requires either `jobs_results` or `search_metadata`. An empty `jobs_results` is
 * a legitimate zero-result search and passes; a body with neither field is not a
 * Google Jobs payload at all.
 */
function isGoogleJobsPayload(body: unknown): body is SerpApiSearchResponse {
  if (typeof body !== "object" || body === null) {
    return false;
  }

  const candidate = body as SerpApiSearchResponse;

  return Array.isArray(candidate.jobs_results) || typeof candidate.search_metadata === "object";
}