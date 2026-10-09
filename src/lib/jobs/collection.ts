import type { Collection } from "mongodb";

import { getDb } from "@/lib/mongodb/client";
import type {
  JobSearchMetadata,
  JobSourceKind,
  NormalizedJob,
  OfficialDiscoveryStatus,
  SearchAttempt,
} from "@/lib/jobs/types";

/**
 * Collections behind "which jobs have I already seen?".
 *
 * Two collections, because they answer two different questions with two different
 * shapes of data:
 *
 * - `job_discovery_seen` — one document per (user, listing). This is the memory
 *   that makes `isNew` mean anything. It grows with the number of *listings*, not
 *   with the number of scans, so it is pruned by age.
 * - `job_discovery_scans` — one document per scan. This is the record of what
 *   happened: counts for diagnosis, plus the full payload of the *most recent*
 *   scan so a page refresh can restore results instead of destroying them. It
 *   grows with scans, so it expires by TTL; `recordScan` strips the payload from
 *   older documents so only one snapshot per user is ever held.
 *
 * A stored snapshot is never an input to a new scan. Job details are re-fetched
 * from SerpApi on every scan by design: a stored job would go stale silently,
 * and a listing that disappeared from Google should stop being reported rather
 * than being served from a cache. The snapshot exists solely to redraw what a
 * completed scan already showed, and it is discarded — not re-read — the moment
 * a new scan runs or the profile it was produced from changes.
 */

export const SEEN_JOBS_COLLECTION = "job_discovery_seen";
export const DISCOVERY_SCANS_COLLECTION = "job_discovery_scans";

/**
 * Cached official-careers discovery outcomes.
 *
 * One document per employer+role+location identity. It exists so a repeated
 * employer across scans (and across users) does not re-issue the same lookup,
 * which is the main control on discovery cost. Both positive and negative
 * outcomes are cached: "we looked and found nothing" is as worth remembering as
 * "we found the employer's page", and it stops a hopeless employer being
 * re-searched on every scan. Documents expire individually via `expiresAt`.
 */
export const DESTINATION_CACHE_COLLECTION = "job_discovery_destinations";

/** Index supporting the per-document expiry of the destination cache. */
export const DESTINATION_CACHE_TTL_INDEX_NAME = "expiresAt_ttl";

/** Unique index making (userId, fingerprint) the identity of a seen listing. */
export const SEEN_JOB_INDEX_NAME = "userId_fingerprint_unique";

/** Index supporting the age-based prune below. */
export const SEEN_JOB_LAST_SEEN_INDEX_NAME = "lastSeenAt_prune";

/** Index on `scannedAt`, expiring scan records so the collection cannot grow forever. */
export const SCAN_SCANNED_AT_INDEX_NAME = "scannedAt_ttl";

/**
 * How long a scan record is kept.
 *
 * Mostly diagnostics; the most recent record also backs refresh-restore, so this
 * is how long a completed scan survives a refresh. Thirty days is far beyond
 * any plausible gap between two page loads of the same session.
 */
export const SCAN_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long a listing stays in the seen history.
 *
 * This is what stops the collection growing without bound, and it has a visible
 * consequence: a listing that keeps coming back for longer than this stops being
 * new and gets its NEW badge again. That is the honest behaviour given the
 * constraint — an unbounded history of every listing a user ever saw is a data
 * store with no end, and 60 days covers the cycle people actually care about
 * ("have I seen this in the last couple of months?").
 */
export const SEEN_RETENTION_DAYS = 60;

/** One listing this user has been shown. */
export type SeenJobDocument = {
  userId: string;
  /** The deterministic fingerprint from `@/lib/jobs/normalize`. */
  fingerprint: string;
  /** When this listing was first seen. Never moved. */
  firstSeenAt: Date;
  /** When this listing was last returned by a scan. Moves every time. */
  lastSeenAt: Date;
};

/**
 * The record of one completed scan: counts and inputs, plus — on the most
 * recent scan only — the payload a refresh restores.
 */
export type DiscoveryScanDocument = {
  userId: string;
  scannedAt: Date;
  /** Jobs in the response, after dedupe and filtering. */
  total: number;
  /** How many were not in the user's history before this scan. */
  newCount: number;
  searchedRoles: string[];
  searchedLocations: string[];
  /** SerpApi requests issued. */
  searchCount: number;
  /** Requests that failed. */
  failedSearchCount: number;
  /** False when the history could not be read or written during this scan. */
  newTrackingAvailable: boolean;

  /**
   * The full payload of the scan, so a page refresh can restore what it found
   * instead of showing an empty state over genuinely completed work.
   *
   * Optional on the document because only the most recent scan of a user keeps
   * it (`recordScan` strips it from older records) and because records written
   * before restore existed have none at all. A reader must therefore treat
   * absence as "nothing to restore", never as an error.
   */
  jobs?: NormalizedJob[];
  metadata?: JobSearchMetadata;
  attempts?: SearchAttempt[];
  /**
   * The profile's `resumeFileId` at scan time. Restore is refused when the
   * profile's current value differs: a replaced resume invalidates everything
   * derived from the old one, and showing the old scan's jobs would contradict
   * the nodes above them.
   */
  resumeFileId?: string | null;
};

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * One cached official-careers outcome, keyed by employer+role+location.
 *
 * The `jobId` is deliberately not stored: the identity is the employer/role, so
 * the same finding serves every listing that shares it. The caller re-attaches
 * the job id when it reads.
 */
export type DiscoveryDestinationDocument = {
  key: string;
  status: OfficialDiscoveryStatus;
  evidence: string[];
  /** The verified destination, present only for the two verified statuses. */
  destination?: {
    url: string;
    kind: JobSourceKind;
    provider: string;
    evidence: string[];
  };
  resolvedAt: Date;
  expiresAt: Date;
};

let indexPromise: Promise<void> | null = null;

/**
 * Ensures the discovery indexes exist, at most once per process.
 *
 * Lazy, so importing this module never touches the database. A failed attempt is
 * not cached, so one transient outage does not permanently disable new-job
 * tracking for the lifetime of the server.
 */
export function ensureDiscoveryIndexes(): Promise<void> {
  if (indexPromise === null) {
    indexPromise = createIndexes().catch((error: unknown) => {
      indexPromise = null;
      throw error;
    });
  }

  return indexPromise;
}

let destinationIndexPromise: Promise<void> | null = null;

/**
 * Ensures the destination-cache index exists, at most once per process.
 *
 * Kept separate from the scan indexes so a failure to create it never disables
 * new-job tracking, and a discovery cache hit failing never disables discovery.
 */
export function ensureDestinationCacheIndexes(): Promise<void> {
  if (destinationIndexPromise === null) {
    destinationIndexPromise = (async () => {
      const db = await getDb();
      await db
        .collection<DiscoveryDestinationDocument>(DESTINATION_CACHE_COLLECTION)
        .createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: DESTINATION_CACHE_TTL_INDEX_NAME }
        );
    })().catch((error: unknown) => {
      destinationIndexPromise = null;
      throw error;
    });
  }

  return destinationIndexPromise;
}

async function createIndexes(): Promise<void> {
  const db = await getDb();

  await db.collection<SeenJobDocument>(SEEN_JOBS_COLLECTION).createIndex(
    { userId: 1, fingerprint: 1 },
    { unique: true, name: SEEN_JOB_INDEX_NAME }
  );

  await db
    .collection<SeenJobDocument>(SEEN_JOBS_COLLECTION)
    .createIndex({ lastSeenAt: 1 }, { name: SEEN_JOB_LAST_SEEN_INDEX_NAME });

  // `expireAfterSeconds` lets MongoDB delete the document itself; the scan history
  // is diagnostics, so letting the database age it out is simpler and safer than
  // a scheduled prune that would itself need scheduling.
  await db
    .collection<DiscoveryScanDocument>(DISCOVERY_SCANS_COLLECTION)
    .createIndex({ scannedAt: 1 }, { expireAfterSeconds: SCAN_RETENTION_SECONDS, name: SCAN_SCANNED_AT_INDEX_NAME });
}

/** Resolves a collection handle by name, so tests can swap one for a fake. */
export function seenJobsCollection(db: Database): Collection<SeenJobDocument> {
  return db.collection<SeenJobDocument>(SEEN_JOBS_COLLECTION);
}

export function discoveryScansCollection(db: Database): Collection<DiscoveryScanDocument> {
  return db.collection<DiscoveryScanDocument>(DISCOVERY_SCANS_COLLECTION);
}

/** The destination-cache collection, for the cache module to read and write. */
export function destinationCacheCollection(
  db: Database
): Collection<DiscoveryDestinationDocument> {
  return db.collection<DiscoveryDestinationDocument>(DESTINATION_CACHE_COLLECTION);
}

/**
 * Clears the cached index initialization.
 *
 * Exposed for tests, mirroring `__resetProfileIndexes`. Not for application code.
 */
export function __resetDiscoveryIndexes(): void {
  indexPromise = null;
  destinationIndexPromise = null;
}