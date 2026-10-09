/**
 * Persistence for resume metadata.
 *
 * Mirrors the profile repository: MongoDB failures become safe domain errors,
 * and stored documents are re-validated on the way out so a hand-edited or
 * partially written document surfaces as an error rather than as `undefined`
 * fields in a response.
 *
 * Metadata failures reuse the storage error codes rather than inventing a
 * database-specific set: both answer the caller's real question — "did the
 * resume get kept?" — and a file whose metadata never landed is a failure worth
 * reporting, not a silent success.
 */

import type { Collection } from "mongodb";
import { z } from "zod";

import { getDb } from "@/lib/mongodb/client";
import {
  RESUME_FILES_COLLECTION,
  ensureResumeFileIndexes,
  type ResumeFileDocument,
} from "@/lib/resume/collection";
import {
  ResumeStorageError,
  ResumeStorageUnavailableError,
} from "@/lib/resume/errors";
import type {
  ResumeFileExtension,
  StoredResumeFile,
} from "@/lib/resume/types";

type Database = Awaited<ReturnType<typeof getDb>>;

/** Shape of a stored resume, validated on read. */
const storedResumeSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
  extension: z.enum(["pdf", "docx"]),
  sizeBytes: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
  uploadedAt: z.date(),
});

/** Converts a stored document into the domain shape, with an ISO timestamp. */
function toStoredResume(document: ResumeFileDocument): StoredResumeFile {
  const parsed = storedResumeSchema.safeParse(document);
  if (!parsed.success) {
    throw new ResumeStorageError("The stored resume metadata is not readable.");
  }

  return {
    id: parsed.data.id,
    userId: parsed.data.userId,
    originalFilename: parsed.data.originalFilename,
    mimeType: parsed.data.mimeType,
    extension: parsed.data.extension as ResumeFileExtension,
    sizeBytes: parsed.data.sizeBytes,
    storageKey: parsed.data.storageKey,
    uploadedAt: parsed.data.uploadedAt.toISOString(),
  };
}

/** Resolves the collection, translating connection failures into a 503. */
async function getResumeFilesCollection(): Promise<Collection<ResumeFileDocument>> {
  let db: Database;
  try {
    db = await getDb();
  } catch (error) {
    throw new ResumeStorageUnavailableError("The database is unavailable.", { cause: error });
  }

  return db.collection<ResumeFileDocument>(RESUME_FILES_COLLECTION);
}

/** Wraps a collection operation so driver failures never reach the caller. */
async function run<T>(
  operation: (collection: Collection<ResumeFileDocument>) => Promise<T>,
): Promise<T> {
  try {
    return await operation(await getResumeFilesCollection());
  } catch (error) {
    if (error instanceof ResumeStorageError || error instanceof ResumeStorageUnavailableError) {
      throw error;
    }

    throw new ResumeStorageError("The resume metadata could not be read or written.", {
      cause: error,
    });
  }
}

/**
 * Stores the metadata for a freshly saved file.
 *
 * The binary is written before this call, so a failure here means the service
 * has an orphaned file to clean up.
 */
export async function insertResumeFile(document: ResumeFileDocument): Promise<StoredResumeFile> {
  await run(async (collection) => {
    await ensureResumeFileIndexes();
    await collection.insertOne(document);
  });

  return toStoredResume(document);
}

/** Returns a stored resume by id, or `null` when it does not exist. */
export async function getResumeFileById(id: string): Promise<StoredResumeFile | null> {
  const document = await run((collection) => collection.findOne({ id }));

  return document === null ? null : toStoredResume(document);
}

/**
 * Returns a user's most recent resume, or `null` when they have uploaded none.
 *
 * "Current" is defined as newest-by-upload rather than "the one the profile
 * points at", because the client cannot see a profile pointer and because a
 * profile that failed to link must still find the file the user just uploaded.
 * Replacing a resume appends a new document instead of overwriting the old one,
 * so the previous file's metadata and its rows stay available for rollback;
 * this query is the single place that decides which of them is current.
 *
 * Served by the `userId_uploadedAt` index.
 */
export async function getCurrentResumeFileByUserId(
  userId: string,
): Promise<StoredResumeFile | null> {
  const document = await run((collection) =>
    collection.findOne({ userId }, { sort: { uploadedAt: -1 } }),
  );

  return document === null ? null : toStoredResume(document);
}

/**
 * Removes metadata for a resume.
 *
 * Returns whether a document was actually deleted so the caller can tell a
 * rollback from a no-op. Failures are not swallowed here: a caller discarding
 * metadata during rollback decides whether to ignore them, because only the
 * caller knows an original error is already propagating.
 */
export async function deleteResumeFile(id: string): Promise<boolean> {
  const result = await run((collection) => collection.deleteOne({ id }));

  return result.deletedCount > 0;
}