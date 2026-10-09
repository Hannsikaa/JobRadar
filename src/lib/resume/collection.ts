import type { Collection } from "mongodb";

import { getDb } from "@/lib/mongodb/client";
import type { ResumeFileExtension } from "@/lib/resume/types";

/**
 * Collection access for resume metadata.
 *
 * Only metadata lives here — the bytes are in {@link ResumeStorage}. The
 * collection name and index definitions live in this file so the repository,
 * the tests, and any future cleanup job all agree on them.
 */

export const RESUME_FILES_COLLECTION = "resumeFiles";

/** Unique index on the generated resume id. */
export const RESUME_ID_INDEX_NAME = "id_unique";

/** Supports listing a user's uploads newest-first. */
export const RESUME_USER_UPLOADED_INDEX_NAME = "userId_uploadedAt";

/**
 * A resume document as stored in MongoDB.
 *
 * `uploadedAt` is a `Date` here for the same reason as `ProfileDocument`: BSON
 * dates are queryable and sortable, and the repository converts to ISO strings
 * on the way out.
 */
export type ResumeFileDocument = {
  id: string;
  userId: string;
  originalFilename: string;
  mimeType: string;
  extension: ResumeFileExtension;
  sizeBytes: number;
  /** Where the bytes live. Never leaves the server. */
  storageKey: string;
  uploadedAt: Date;
};

let indexPromise: Promise<void> | null = null;

/**
 * Ensures the resume indexes exist, at most once per process.
 *
 * Lazy so importing this module never touches the database, and a failed
 * attempt is not cached so the next request retries.
 */
export function ensureResumeFileIndexes(): Promise<void> {
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
  const collection = resumeFilesCollection(db);

  await collection.createIndex({ id: 1 }, { unique: true, name: RESUME_ID_INDEX_NAME });
  await collection.createIndex(
    { userId: 1, uploadedAt: -1 },
    { name: RESUME_USER_UPLOADED_INDEX_NAME },
  );
}

function resumeFilesCollection(db: Awaited<ReturnType<typeof getDb>>): Collection<ResumeFileDocument> {
  return db.collection<ResumeFileDocument>(RESUME_FILES_COLLECTION);
}

/**
 * Clears the cached index initialization.
 *
 * Exposed for tests, which need each case to start from a fresh attempt. Not
 * intended for application code.
 */
export function __resetResumeFileIndexes(): void {
  indexPromise = null;
}