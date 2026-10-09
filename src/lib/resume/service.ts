/**
 * The resume upload flow.
 *
 * This is the single place that knows the order of operations:
 *
 *   validate → store bytes → store metadata → link profile
 *
 * Each step can fail, and a failure after the bytes are on disk is rolled back
 * so the system never keeps a file that nothing points at. Ordering matters for
 * a second reason: validation is cheapest and rejects the most input, so it runs
 * first, and the binary is stored before its metadata so that a metadata failure
 * can be undone by deleting the file.
 *
 * The route handler calls this and nothing else; storage and database access are
 * injected so tests can exercise the ordering and the rollback.
 */

import { randomUUID } from "node:crypto";

import {
  ResumeError,
  ResumeUploadError,
} from "@/lib/resume/errors";
import { setProfileResumeFileId } from "@/lib/profile/repository";
import {
  createLocalResumeStorage,
  buildStorageKey,
  type ResumeStorage,
} from "@/lib/resume/storage";
import type {
  ResumeFileMetadata,
  StoredResumeFile,
} from "@/lib/resume/types";
import { toResumeFileMetadata } from "@/lib/resume/types";
import {
  deleteResumeFile,
  getCurrentResumeFileByUserId,
  insertResumeFile,
} from "@/lib/resume/repository";
import { validateResumeFile } from "@/lib/resume/validation";

/** Collaborators the flow needs. Only storage is swappable in tests. */
export type UploadResumeDependencies = {
  storage: ResumeStorage;
};

/** What a successful upload reports back to the caller. */
export type UploadResumeResult = {
  /** Public metadata. Never includes the storage key or the file contents. */
  resume: ResumeFileMetadata;
  /** Whether an existing profile was updated to point at this file. */
  profileLinked: boolean;
  /**
   * Whether this upload replaced a resume the user already had.
   *
   * Reported so the client can react to the fact that anything derived from the
   * previous file is now stale. `false` for a first upload, which is the common
   * case, so it stays quiet rather than announcing a change that did not happen.
   */
  replaced: boolean;
};

/**
 * Discards the metadata written for an upload that then failed.
 *
 * Best-effort by design: this only runs while another error is already
 * propagating, and swallowing a cleanup failure keeps that original error — the
 * one worth reporting — as the one the caller sees.
 */
async function discardMetadata(id: string): Promise<void> {
  await deleteResumeFile(id).catch(() => undefined);
}

/**
 * Stores a resume and, when the user already has one, points their profile at
 * it.
 *
 * Throws a `ResumeError` for every failure. The file is uploaded whether or not
 * a profile exists yet — uploading before building a profile is a normal order
 * of operations — so a missing profile is reported as `profileLinked: false`
 * rather than treated as a failure.
 *
 * Whether this is a replacement is decided *before* anything is written, while
 * the failure is still free to clean up. A replacement appends rather than
 * overwrites, so the previous file's bytes and metadata stay intact for
 * rollback; `replaced` is what lets the caller know a profile derived from that
 * older file no longer matches what the user just uploaded.
 */
export async function uploadResume(
  userId: string,
  file: File,
  dependencies: UploadResumeDependencies = {
    storage: createLocalResumeStorage(),
  },
): Promise<UploadResumeResult> {
  const { storage } = dependencies;
  const validated = await validateResumeFile(file);

  // Read the current resume first: nothing exists on disk yet, so if this
  // fails the caller gets a clean error instead of an orphaned upload.
  const previous = await getCurrentResumeFileByUserId(userId);

  const id = randomUUID();
  const storageKey = buildStorageKey(id, validated.extension);

  // Before this point nothing exists on disk, so a failure needs no cleanup.
  await storage.save(storageKey, new Uint8Array(await file.arrayBuffer()));

  let stored: StoredResumeFile;
  try {
    stored = await insertResumeFile({
      id,
      userId,
      originalFilename: validated.originalFilename,
      mimeType: validated.mimeType,
      extension: validated.extension,
      sizeBytes: validated.sizeBytes,
      storageKey,
      uploadedAt: new Date(),
    });
  } catch (error) {
    await removeQuietly(storage, storageKey);
    throw error;
  }

  let profileLinked: boolean;
  try {
    profileLinked = await setProfileResumeFileId(userId, id);
  } catch (error) {
    // A failure here means the database is unhappy, and metadata we cannot
    // reliably delete would leave the profile pointing at a file nothing tracks.
    // Undo both halves and report the failure.
    await discardMetadata(id);
    await removeQuietly(storage, storageKey);
    throw error;
  }

  return {
    resume: toResumeFileMetadata(stored),
    profileLinked,
    replaced: previous !== null,
  };
}

/** Deletes a stored file, ignoring failures while unwinding another error. */
async function removeQuietly(storage: ResumeStorage, storageKey: string): Promise<void> {
  await storage.delete(storageKey).catch(() => undefined);
}

/**
 * Normalizes an unexpected error from this flow into a `ResumeError`.
 *
 * The rollback paths re-throw whatever they caught, which may be a driver or
 * filesystem error; the route maps both classes onto the same safe status.
 */
export function toResumeUploadError(error: unknown): ResumeError {
  return error instanceof ResumeError
    ? error
    : new ResumeUploadError("The resume could not be saved.", { cause: error });
}