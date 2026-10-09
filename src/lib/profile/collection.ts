import type { Collection, Document } from "mongodb";

import { getDb } from "@/lib/mongodb/client";

/**
 * Collection access for profiles.
 *
 * The collection name and the unique index live here so the repository, the
 * tests, and any future background job all agree on them.
 */

export const PROFILES_COLLECTION = "profiles";

/** Name of the unique index on `userId`, referenced by tests and migrations. */
export const USER_ID_INDEX_NAME = "userId_unique";

/**
 * A profile document as stored in MongoDB.
 *
 * Timestamps are `Date` here rather than ISO strings: they are stored as BSON
 * dates so they can be queried and sorted by the database. The repository
 * converts them to ISO strings on the way out.
 *
 * The three resume-related fields answer three different questions, and keeping
 * them apart is what lets the app tell "the user has a resume" from "this
 * profile text describes that resume":
 *
 * - `resumeFileId` — which upload is current. A newer upload overwrites it.
 * - `parsedResumeFileId` — which upload the `resume` text was extracted from.
 *   The parser writes it, and it does not move when the user edits the text.
 * - `reviewedAt` — when a person last saved the profile deliberately, through
 *   the Profile Review page.
 *
 * When `resumeFileId` and `parsedResumeFileId` disagree the stored text predates
 * the current file and must not be presented as if it described it. See
 * `@/lib/profile/state`.
 */
export type ProfileDocument = {
  userId: string;
  resume: Document;
  preferences: Document;
  /** Id of the resume upload this profile was last linked to, if any. */
  resumeFileId?: string;
  /** Id of the resume upload the stored `resume` text was parsed from. */
  parsedResumeFileId?: string;
  /** When a person last saved this profile through Profile Review. */
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

let indexPromise: Promise<void> | null = null;

/**
 * Ensures the unique `userId` index exists, at most once per process.
 *
 * Lazy so that importing this module never touches the database. A failed
 * attempt is not cached: the next call retries instead of caching a rejection
 * that would poison every later request.
 */
export function ensureProfileIndexes(): Promise<void> {
  if (indexPromise === null) {
    indexPromise = createUserIdIndex().catch((error: unknown) => {
      indexPromise = null;
      throw error;
    });
  }

  return indexPromise;
}

async function createUserIdIndex(): Promise<void> {
  const db = await getDb();
  await profilesCollection(db).createIndex({ userId: 1 }, { unique: true, name: USER_ID_INDEX_NAME });
}

function profilesCollection(db: Awaited<ReturnType<typeof getDb>>): Collection<ProfileDocument> {
  return db.collection<ProfileDocument>(PROFILES_COLLECTION);
}

/**
 * Clears the cached index initialization.
 *
 * Exposed for tests, which need each case to start from a fresh attempt. Not
 * intended for application code.
 */
export function __resetProfileIndexes(): void {
  indexPromise = null;
}