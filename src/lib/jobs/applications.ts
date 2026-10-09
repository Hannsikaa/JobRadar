import type { Collection } from "mongodb";

import { getDb } from "@/lib/mongodb/client";

/**
 * The memory of which jobs this user has marked applied.
 *
 * This is deliberately the smallest store in the app: one document per
 * (user, job), and the only thing it records is *that* the user said they
 * applied — not when they interviewed, not a stage, not a pipeline. Those are a
 * different product; this exists so a refresh does not reset a checkbox the user
 * deliberately set.
 *
 * A job is identified by its stable `NormalizedJob.id`, the same id the UI keys
 * cards by, so an applied mark survives reloads, re-scans, and deduplication.
 * The store is per-user, keyed by the same `userId` every other endpoint uses,
 * so nothing here can leak one user's marks into another's list.
 *
 * Every read and write is best-effort. MongoDB may be unconfigured or briefly
 * unreachable in a local demo, and application status must never be the reason a
 * page fails to render: an unavailable store simply reports `available: false`
 * and the UI falls back to "nothing applied yet".
 */

export const JOB_APPLICATIONS_COLLECTION = "job_applications";

/** Name of the unique index on `(userId, jobId)`, referenced by tests. */
export const JOB_APPLICATION_INDEX_NAME = "userId_jobId_unique";

/** One applied mark. Presence of the document *is* the fact. */
export type JobApplicationDocument = {
  userId: string;
  jobId: string;
  appliedAt: Date;
};

type Database = Awaited<ReturnType<typeof getDb>>;

let indexPromise: Promise<void> | null = null;

/**
 * Ensures the application index exists, at most once per process.
 *
 * Lazy, so importing the module never opens a socket; a failed attempt is not
 * cached, so a transient outage does not disable the store for the process's
 * lifetime.
 */
export function ensureApplicationIndexes(): Promise<void> {
  if (indexPromise === null) {
    indexPromise = createIndexes().catch((error: unknown) => {
      indexPromise = null;
      throw error;
    });
  }

  return indexPromise;
}

async function createIndexes(): Promise<void> {
  const db = await getDb();

  await db.collection<JobApplicationDocument>(JOB_APPLICATIONS_COLLECTION).createIndex(
    { userId: 1, jobId: 1 },
    { unique: true, name: JOB_APPLICATION_INDEX_NAME }
  );
}

/** Resolves a collection handle by name, so tests can swap one for a fake. */
export function jobApplicationsCollection(db: Database): Collection<JobApplicationDocument> {
  return db.collection<JobApplicationDocument>(JOB_APPLICATIONS_COLLECTION);
}

/** Clears the cached index initialization. Exposed for tests. */
export function __resetApplicationIndexes(): void {
  indexPromise = null;
}

/**
 * The result of reading the store.
 *
 * `available: false` means the question could not be answered — not that the
 * answer is "none". The distinction matters because the UI must not render
 * "not applied" as a fact when it is only the absence of an answer.
 */
export type ApplicationList = {
  available: boolean;
  appliedIds: Set<string>;
};

/** Every job id this user has marked applied. */
export async function listAppliedJobIds(userId: string): Promise<ApplicationList> {
  try {
    const db = await getDb();
    await ensureApplicationIndexes();

    const docs = await jobApplicationsCollection(db)
      .find({ userId }, { projection: { _id: 0, jobId: 1 } })
      .toArray();

    const appliedIds = new Set<string>();

    for (const doc of docs) {
      if (typeof doc.jobId === "string" && doc.jobId.length > 0) {
        appliedIds.add(doc.jobId);
      }
    }

    return { available: true, appliedIds };
  } catch {
    return { available: false, appliedIds: new Set() };
  }
}

/**
 * Marks or unmarks one job.
 *
 * Returns whether the write landed. Marking is an idempotent upsert and
 * unmarking deletes at most one document, so a repeated click is harmless.
 */
export async function setJobApplied(
  userId: string,
  jobId: string,
  applied: boolean,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const db = await getDb();
    await ensureApplicationIndexes();

    const collection = jobApplicationsCollection(db);

    if (applied) {
      // The equality filter supplies userId and jobId on insert; only the
      // timestamp is set here, which keeps the document and the index in step.
      await collection.updateOne({ userId, jobId }, { $set: { appliedAt: now } }, { upsert: true });
    } else {
      await collection.deleteOne({ userId, jobId });
    }

    return true;
  } catch {
    return false;
  }
}
