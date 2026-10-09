/**
 * Direct ATS adapters: reading an employer's *own* board.
 *
 * Official-careers discovery so far is a *verification* pass: it asks a web search
 * whether a listing Google Jobs surfaced can be traced to the employer's page.
 * That finds an employer's board only when the search engine happens to surface
 * it, and it never asks the board what else is open.
 *
 * This module is the other half. Several applicant-tracking systems expose a
 * documented, public, read-only JSON endpoint for an employer's board. When a
 * listing's own apply link already proved which board belongs to the employer
 * (`classifyDestination` → `verified_employer_ats`), that board can be queried
 * directly for every currently-listed opening — jobs Google Jobs has not returned
 * yet.
 *
 * What these adapters deliberately do **not** do:
 *
 * 1. **No tenant guessing.** A tenant is only ever taken from a URL the provider
 *    actually returned, and it is only queried once `tenantMatchesEmployer`
 *    confirms the board belongs to the advertised employer.
 * 2. **No scraping.** Every adapter calls a documented public JSON endpoint with
 *    a plain GET and a timeout. No HTML parsing, no auth bypass, no anti-bot
 *    circumvention.
 * 10. **No fabrication.** `parse` only maps fields the payload actually carries;
 *    anything absent stays absent.
 */

/** The platforms with a verified, public, JSON job-board interface. */
export type AtsPlatform = "greenhouse" | "lever" | "ashby";

/** The employer-owned identity of a board: a platform and its tenant token. */
export type AtsTenant = {
  platform: AtsPlatform;
  /** The board token exactly as it appears in the ATS URL (never guessed). */
  tenant: string;
};

/** One currently-listed public posting, straight from an employer's board. */
export type DirectPosting = {
  platform: AtsPlatform;
  tenant: string;
  /** Stable, platform-scoped posting id (the ATS's own id). */
  postingId: string;
  title: string;
  /** The employer's own canonical posting URL. */
  url: string;
  location?: string;
  /** Only set when the board itself states a work arrangement. */
  remote?: boolean;
  /** ISO publication date, when the board states one. */
  publishedAt?: string;
  /** ISO last-updated date, when the board states one. */
  updatedAt?: string;
  /** The employer name the board itself reports, when it does. */
  companyName?: string;
};

/** How one board responded, for honest per-source coverage reporting. */
export type AtsFetchStatus =
  | "ok"
  | "empty"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "malformed";

export type AtsFetchResult = {
  status: AtsFetchStatus;
  postings: DirectPosting[];
  /** Secret-free detail for server logs; never surfaced raw to a client. */
  detail?: string;
};

/**
 * A minimal `fetch`, injected so adapters and orchestration are testable without
 * a network. Structurally compatible with the global `Response`.
 */
export type HttpGetter = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** A platform adapter. `parse` is pure; only `fetchBoard` touches the network. */
export type AtsAdapter = {
  platform: AtsPlatform;
  /** Human label, e.g. "Greenhouse". */
  label: string;
  /** Registrable domains this platform serves boards from. */
  hosts: readonly string[];
  /** The public board endpoint for a tenant. */
  boardUrl(tenant: string): string;
  /**
   * Maps a board payload to postings. Pure and total: a payload that does not
   * shape-check returns `null` (malformed) rather than throwing, and an entry
   * missing a title, URL, or id is skipped.
   */
  parse(payload: unknown, tenant: string): DirectPosting[] | null;
};
