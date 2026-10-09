import type { DiscoveryScanDocument } from "@/lib/jobs/collection";
import { getLastScan } from "@/lib/jobs/discovery";
import type { JobSearchResult } from "@/lib/jobs/types";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import { UserIdentityError } from "@/lib/identity/user-id";
import { ProfileStoreError, ProfileStoreUnavailableError } from "@/lib/profile/errors";
import { getProfileByUserId } from "@/lib/profile/repository";
import type { StoredProfile } from "@/lib/profile/types";

/**
 * GET /api/jobs/last — the caller's most recent completed scan, if it is still
 * current.
 *
 * This exists so a page refresh does not destroy state: the jobs a real scan
 * found, the nodes it completed, are redrawn from the record of that scan
 * instead of collapsing to an empty workflow. The response is
 * `{ result: JobSearchResult | null }`, where `null` means "nothing to
 * restore" — a first visit, a scan older than the record retention, or a scan
 * that no longer describes the profile on file. `null` is an answer, not an
 * error, so it is a 200.
 *
 * Two conditions decide whether a stored scan may be shown again, and both are
 * about honesty rather than convenience:
 *
 * 1. **The resume must be the same one the scan ran against.** A replacement
 *    resume invalidates everything derived from the old one; restoring the old
 *    scan's jobs under a new resume would contradict the nodes above them.
 * 2. **The profile must not have changed since the scan.** Any later edit — a
 *    re-parse, a re-saved preference — moves `updatedAt` past `scannedAt`, and
 *    the stored jobs were never scored against the new profile.
 *
 * A stored payload is read defensively: this is untrusted-in-shape data (it
 * came out of a database document that may predate the current schema), so a
 * record that does not shape-check is treated as nothing to restore rather than
 * being forwarded and allowed to break the client.
 *
 * The response is `no-store` like every other job response: it is per-user
 * state that changes on every scan, and a cached copy would leak one caller's
 * results into the next load.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  let userId: string;

  try {
    userId = resolveUserId(request);
  } catch (error) {
    return json(
      {
        error: {
          code: "unauthenticated",
          message:
            error instanceof UserIdentityError
              ? "The request could not be attributed to a user. Reload the page and try again."
              : "The request could not be attributed to a user.",
        },
      },
      401
    );
  }

  try {
    const [profile, scan] = await Promise.all([getProfileByUserId(userId), getLastScan(userId)]);

    return json({ result: profile === null ? null : readRestorableResult(scan, profile) }, 200);
  } catch (error) {
    if (error instanceof ProfileStoreUnavailableError || error instanceof ProfileStoreError) {
      console.error("[jobs] last scan: profile could not be read", error);

      return json(
        {
          error: {
            code: "profile_unavailable",
            message: "Your profile could not be read, so the previous scan could not be restored.",
          },
        },
        503
      );
    }

    console.error("[jobs] last scan: unhandled failure", error);

    return json(
      { error: { code: "internal_error", message: "The previous scan could not be restored." } },
      500
    );
  }
}

/**
 * Turns a stored scan into a result the client may redraw, or `null`.
 *
 * Exported for tests: the freshness rules above are the whole point of this
 * endpoint, and they are the part most likely to rot silently.
 */
export function readRestorableResult(
  scan: DiscoveryScanDocument | null,
  profile: StoredProfile
): JobSearchResult | null {
  if (scan === null) {
    return null;
  }

  // The resume this scan ran against must still be the profile's resume.
  if ((scan.resumeFileId ?? null) !== (profile.resumeFileId ?? null)) {
    return null;
  }

  // The profile must not have been edited after the scan finished. An
  // unparseable timestamp on either side fails closed: showing a possibly
  // stale scan is worse than making the user press Start once.
  const scannedAt = asTime(scan.scannedAt);
  const updatedAt = asTime(profile.updatedAt);

  if (scannedAt === null || updatedAt === null || scannedAt < updatedAt) {
    return null;
  }

  if (!Array.isArray(scan.jobs) || !Array.isArray(scan.attempts)) {
    return null;
  }

  const metadata = scan.metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }

  // The counts the client does arithmetic on (`x/y searches`, `n matches`) must
  // be numbers; a record missing them would render "NaN/NaN" on a node caption.
  const counts = [
    metadata.total,
    metadata.searchCount,
    metadata.failedSearchCount,
    metadata.rawCount,
    metadata.duplicateCount,
  ];
  if (!counts.every((count) => typeof count === "number" && Number.isFinite(count))) {
    return null;
  }

  return { jobs: scan.jobs, metadata, attempts: scan.attempts };
}

/** Reads a `Date` or an ISO string as epoch milliseconds, or `null`. */
function asTime(value: Date | string): number | null {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);

  return Number.isFinite(time) ? time : null;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE }) as Response;
}
