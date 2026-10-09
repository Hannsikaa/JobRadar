import type { Collection } from "mongodb";

import {
  discoveryScansCollection,
  ensureDiscoveryIndexes,
  SEEN_RETENTION_DAYS,
  seenJobsCollection,
  type DiscoveryScanDocument,
  type SeenJobDocument,
} from "@/lib/jobs/collection";
import { getDb } from "@/lib/mongodb/client";

/**
 * New-job detection: the memory of what this user has already been shown.
 *
 * "NEW" is the only claim in this app that depends on history, so this module is
 * deliberately careful about when it is allowed to make that claim:
 *
 * 1. **A listing's identity is a fingerprint, not a URL.** Aggregators reissue
 *    share links, so a URL-based history would report a job as new every scan.
 * 2. **A scan reads before it writes.** Which listings are new is decided by what
 *    the history held *before* this scan, so the first scan of a listing is the
 *    only one that can badge it.
 * 3. **An unreadable history never produces a claim.** If MongoDB is not
 *    configured or not reachable, the result is `available: false` and *no* job is
 *    called new. Showing a job without a badge is a smaller error than claiming
 *    it is new and being wrong.
 *
 * Race behaviour, stated rather than hidden: two scans running at the same moment
 * for the same user can both find a listing absent and both badge it NEW. Both
 * were genuinely the first time either had seen it, so this is the truthful
 * answer to each of them, and it is far better than serializing scans behind a
 * lock.
 */

/** The outcome of consulting and updating the history for one scan. */
export type SeenJobsOutcome = {
  /**
   * False when the history could not be read or written. Every job then carries
   * `isNew: false` and the scan reports `newTrackingAvailable: false`, so the
   * absence of NEW badges is disclosed rather than looking like "nothing new".
   */
  available: boolean;
  /** Fingerprints not present in the history before this scan. */
  newFingerprints: Set<string>;
  /** Fingerprints that were already in the history. */
  seenFingerprints: Set<string>;
  /** Server-side only. Why tracking is unavailable, for the log. Never returned. */
  reason?: unknown;
};

/** MongoDB caps `$in` reasonably low; well under the limit, but chunked anyway. */
const IN_CHUNK_SIZE = 500;

/** An empty outcome, used whenever the history cannot be consulted. */
function unavailable(reason?: unknown): SeenJobsOutcome {
  return {
    available: false,
    newFingerprints: new Set(),
    seenFingerprints: new Set(),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Splits a list into `$in`-sized chunks. */
function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

/**
 * Reads the history, decides which listings are new, and records this sighting.
 *
 * Never throws. A failure anywhere — unconfigured database, unreachable server,
 * a write that did not land — resolves to `available: false`, because the caller
 * must be able to return results either way. A discovery store problem is never
 * allowed to become a failed job search.
 *
 * `now` is injectable so retention and `firstSeenAt` are deterministic in tests.
 */
export async function markJobsSeen(
  userId: string,
  fingerprints: readonly string[],
  now: Date = new Date()
): Promise<SeenJobsOutcome> {
  const unique = [...new Set(fingerprints.filter((entry) => entry.length > 0))];

  // An empty result set needs no history: there is nothing to compare and
  // nothing to record. Reporting `available: false` here would wrongly suggest
  // the database is down when in fact the search simply found nothing.
  if (unique.length === 0) {
    return { available: true, newFingerprints: new Set(), seenFingerprints: new Set() };
  }

  let collection;
  try {
    const db = await getDb();
    await ensureDiscoveryIndexes();
    collection = seenJobsCollection(db);
  } catch (error) {
    return unavailable(error);
  }

  // --- Read: what has this user already been shown? ------------------------
  const alreadySeen = new Set<string>();

  try {
    for (const group of chunk(unique, IN_CHUNK_SIZE)) {
      const documents = await collection
        .find({ userId, fingerprint: { $in: group } }, { projection: { fingerprint: 1 } })
        .toArray();

      for (const document of documents) {
        if (typeof document.fingerprint === "string") {
          alreadySeen.add(document.fingerprint);
        }
      }
    }
  } catch (error) {
    return unavailable(error);
  }

  const newFingerprints = new Set<string>();
  const seenFingerprints = new Set<string>();

  for (const fingerprint of unique) {
    if (alreadySeen.has(fingerprint)) {
      seenFingerprints.add(fingerprint);
    } else {
      newFingerprints.add(fingerprint);
    }
  }

  // --- Write: remember this sighting ----------------------------------------
  try {
    await collection.bulkWrite(
      unique.map((fingerprint) => ({
        updateOne: {
          filter: { userId, fingerprint },
          // `firstSeenAt` is only ever written on insert, which is what makes it
          // the actual first sighting rather than the most recent one.
          update: {
            $set: { lastSeenAt: now },
            $setOnInsert: { firstSeenAt: now },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    await pruneStaleEntries(collection, userId, now);
  } catch (error) {
    // The read succeeded but the write did not, so the history is now not
    // trustworthy: this scan's NEW claims could not be recorded and would
    // repeat on every future scan. Report unavailable rather than re-badge the
    // same jobs forever.
    return unavailable(error);
  }

  return { available: true, newFingerprints, seenFingerprints };
}

/**
 * Drops history entries the user has not been shown in a while.
 *
 * Best-effort by design: pruning is housekeeping, and a failure to prune must not
 * turn a successful scan into an error or a missing NEW badge. It only bounds
 * growth in time, so the next scan will try again.
 */
async function pruneStaleEntries(
  collection: Collection<SeenJobDocument>,
  userId: string,
  now: Date
): Promise<void> {
  const cutoff = new Date(now.getTime() - SEEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  try {
    await collection.deleteMany({ userId, lastSeenAt: { $lt: cutoff } });
  } catch {
    // Housekeeping only. See the doc comment.
  }
}

/** What a scan record needs. Mirrors the metadata the response already carries. */
export type ScanSummary = Omit<
  DiscoveryScanDocument,
  "userId" | "scannedAt" | "searchedRoles" | "searchedLocations"
> & {
  searchedRoles: readonly string[];
  searchedLocations: readonly string[];
};

/**
 * Records that a scan finished.
 *
 * The full payload (jobs, metadata, attempts, the resume it ran against) is
 * stored on the new record so a page refresh can restore it, and stripped from
 * every older record of the same user in the same call — only the most recent
 * scan is restorable, and keeping every previous snapshot would duplicate job
 * data for no benefit.
 *
 * Returns whether the record was written. A failed record does not invalidate
 * the scan: the jobs were found and scored, and refusing to show them because
 * the history note could not be saved would be a worse outcome for the user.
 * Losing the snapshot only costs restore; the next scan re-establishes it.
 */
export async function recordScan(
  userId: string,
  summary: ScanSummary,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const db = await getDb();
    const document: DiscoveryScanDocument = {
      userId,
      scannedAt: now,
      total: summary.total,
      newCount: summary.newCount,
      searchedRoles: [...summary.searchedRoles],
      searchedLocations: [...summary.searchedLocations],
      searchCount: summary.searchCount,
      failedSearchCount: summary.failedSearchCount,
      newTrackingAvailable: summary.newTrackingAvailable,
      ...(summary.jobs === undefined ? {} : { jobs: summary.jobs }),
      ...(summary.metadata === undefined ? {} : { metadata: summary.metadata }),
      ...(summary.attempts === undefined ? {} : { attempts: summary.attempts }),
      ...(summary.resumeFileId === undefined ? {} : { resumeFileId: summary.resumeFileId }),
    };

    const collection = discoveryScansCollection(db);
    await collection.insertOne(document);

    // Best-effort demotion of older snapshots: a failure only means two records
    // carry a payload, which the TTL bounds anyway. It must not turn a written
    // record into a reported failure.
    try {
      await collection.updateMany(
        { userId, scannedAt: { $lt: now } },
        { $unset: { jobs: "", metadata: "", attempts: "", resumeFileId: "" } }
      );
    } catch {
      // See doc comment.
    }

    return true;
  } catch {
    return false;
  }
}

/** The user's most recent scan record, or `null` when they have never scanned. */
export async function getLastScan(userId: string): Promise<DiscoveryScanDocument | null> {
  try {
    const db = await getDb();
    const document = await discoveryScansCollection(db).findOne(
      { userId },
      { sort: { scannedAt: -1 } }
    );

    return document ?? null;
  } catch {
    return null;
  }
}