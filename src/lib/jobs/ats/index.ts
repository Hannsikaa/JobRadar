import { ashbyAdapter } from "./ashby";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import type {
  AtsAdapter,
  AtsFetchResult,
  AtsPlatform,
  AtsTenant,
  HttpGetter,
} from "./types";
import { boardTokenFromPath, matchesHost } from "./util";

export type {
  AtsAdapter,
  AtsFetchResult,
  AtsFetchStatus,
  AtsPlatform,
  AtsTenant,
  DirectPosting,
  HttpGetter,
} from "./types";

/**
 * The supported direct-source platforms.
 *
 * Only platforms whose public board interface has been verified live are listed.
 * A platform is added here when its endpoint is documented, returns JSON without
 * authentication, and can be read without scraping.
 */
const ADAPTERS: readonly AtsAdapter[] = [greenhouseAdapter, leverAdapter, ashbyAdapter];

/** The adapter for a platform, or `null` when it is not supported. */
export function getAdapter(platform: AtsPlatform): AtsAdapter | null {
  return ADAPTERS.find((adapter) => adapter.platform === platform) ?? null;
}

/** The adapter that serves a host, or `null`. */
export function adapterForHost(host: string): AtsAdapter | null {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  return (
    ADAPTERS.find((adapter) => adapter.hosts.some((suffix) => matchesHost(normalized, suffix))) ??
    null
  );
}

/** The human label for a platform ("Greenhouse", …). */
export function platformLabel(platform: AtsPlatform): string {
  return getAdapter(platform)?.label ?? platform;
}

/** True when the platform has a verified adapter. */
export function isSupportedPlatform(platform: string): platform is AtsPlatform {
  return ADAPTERS.some((adapter) => adapter.platform === platform);
}

/**
 * Reads a supported ATS board location from a URL.
 *
 * This recognises *where* a board lives, not *whose* it is: the caller must still
 * verify the tenant against the advertised employer. A non-ATS URL, or one with
 * no usable token, returns `null`.
 */
export function atsLocationOf(url: string): AtsTenant | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const adapter = adapterForHost(parsed.hostname);
  if (adapter === null) {
    return null;
  }

  const tenant = boardTokenFromPath(parsed.pathname);
  if (tenant === undefined) {
    return null;
  }

  return { platform: adapter.platform, tenant };
}

/**
 * Default per-board timeout. ATS boards are normally fast, but a large board can
 * be several megabytes of JSON, so the ceiling allows for a slow body read while
 * still bounding a hung connection.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fetches one board and maps it to postings.
 *
 * Never throws: every failure mode becomes an `AtsFetchStatus`, because one
 * unreachable board must not be able to break a scan. A board that responds with
 * zero postings is `empty` — a real answer, not a failure.
 */
export async function fetchBoard(
  tenant: AtsTenant,
  options: { get?: HttpGetter; timeoutMs?: number } = {}
): Promise<AtsFetchResult> {
  const adapter = getAdapter(tenant.platform);
  if (adapter === null) {
    return { status: "unavailable", postings: [], detail: "unsupported platform" };
  }

  const url = adapter.boardUrl(tenant.tenant);
  const get = options.get ?? defaultGet;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const signal = AbortSignal.timeout(timeoutMs);

  let response: Awaited<ReturnType<HttpGetter>>;
  try {
    response = await get(url, {
      signal,
      headers: {
        accept: "application/json",
        "user-agent": "JobRadar/1.0 (+job discovery; respects platform terms)",
      },
    });
  } catch (error) {
    return { status: "unavailable", postings: [], detail: errorName(error) };
  }

  if (response.status === 404) {
    return { status: "not_found", postings: [] };
  }

  if (response.status === 429) {
    return { status: "rate_limited", postings: [] };
  }

  if (!response.ok) {
    return { status: "unavailable", postings: [], detail: `HTTP ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // An abort while the body is still streaming is a timeout, not a bad board:
    // a large board on a slow connection must not be libelled as malformed.
    return signal.aborted
      ? { status: "unavailable", postings: [], detail: "timeout reading board" }
      : { status: "malformed", postings: [], detail: "unreadable body" };
  }

  const postings = adapter.parse(payload, tenant.tenant);
  if (postings === null) {
    return { status: "malformed", postings: [], detail: "unexpected payload" };
  }

  return { status: postings.length === 0 ? "empty" : "ok", postings };
}

/** The production transport: one bounded HTTP GET of a JSON board. */
const defaultGet: HttpGetter = async (url, init) => {
  const response = await fetch(url, { ...init, cache: "no-store" });
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "request failed";
}
