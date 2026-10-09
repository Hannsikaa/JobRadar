import {
  destinationCacheCollection,
  ensureDestinationCacheIndexes,
  type DiscoveryDestinationDocument,
} from "@/lib/jobs/collection";
import type { OfficialDiscoveryOutcome } from "@/lib/jobs/official-careers";
import { getDb } from "@/lib/mongodb/client";

/**
 * Persistent cache for official-careers outcomes.
 *
 * Discovery is metered, so the same employer+role+location must not be looked up
 * again on every scan. The store is keyed by employer identity and role, never
 * by a URL, so an incorrect company/title match can never be retrieved under a
 * different employer's key.
 *
 * Every function is best-effort: a cache that is down must degrade to "do the
 * lookup again", never to a broken scan. Reads swallow errors and return `null`;
 * writes swallow errors and return nothing.
 */

/** The cache contract, injectable so the orchestration can be tested without Mongo. */
export type DestinationCache = {
  read(key: string, now: Date): Promise<OfficialDiscoveryOutcome | null>;
  write(key: string, outcome: OfficialDiscoveryOutcome, ttlMs: number, now: Date): Promise<void>;
};

/** The real store, backed by the existing MongoDB client. */
export function createMongoDestinationCache(): DestinationCache {
  return {
    read: async (key, now) => readCachedDestination(key, now),
    write: async (key, outcome, ttlMs, now) =>
      writeCachedDestination(key, outcome, ttlMs, now),
  };
}

/**
 * Reads an unexpired outcome for `key`, or `null` when there is none, it expired,
 * or the store could not be reached.
 */
export async function readCachedDestination(
  key: string,
  now: Date = new Date()
): Promise<OfficialDiscoveryOutcome | null> {
  try {
    const db = await getDb();
    await ensureDestinationCacheIndexes();

    const document = await destinationCacheCollection(db).findOne({
      key,
      // Belt and braces with the TTL index: a document whose expiry the index
      // has not swept yet must still not be served.
      expiresAt: { $gt: now },
    });

    if (document === null) {
      return null;
    }

    return toOutcome(document);
  } catch {
    return null;
  }
}

/** Stores an outcome under a key with a bounded lifetime. Never throws. */
export async function writeCachedDestination(
  key: string,
  outcome: OfficialDiscoveryOutcome,
  ttlMs: number,
  now: Date = new Date()
): Promise<void> {
  try {
    const db = await getDb();
    await ensureDestinationCacheIndexes();

    const document: DiscoveryDestinationDocument = {
      key,
      status: outcome.status,
      evidence: outcome.evidence,
      resolvedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      ...(outcome.destination === undefined
        ? {}
        : {
            destination: {
              url: outcome.destination.url,
              kind: outcome.destination.kind,
              provider: outcome.destination.provider,
              evidence: outcome.destination.evidence,
            },
          }),
    };

    await destinationCacheCollection(db).updateOne({ key }, { $set: document }, { upsert: true });
  } catch {
    // Best-effort. A cache miss costs one extra lookup; a thrown error would cost
    // the whole scan.
  }
}

/** Rebuilds the cacheable outcome from a stored document. */
function toOutcome(document: DiscoveryDestinationDocument): OfficialDiscoveryOutcome {
  return {
    status: document.status,
    evidence: Array.isArray(document.evidence) ? document.evidence : [],
    ...(document.destination === undefined ? {} : { destination: document.destination }),
  };
}
