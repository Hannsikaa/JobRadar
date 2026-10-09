import { z } from "zod";

import type { Collection } from "mongodb";

import {
  ensureProfileIndexes,
  PROFILES_COLLECTION,
  type ProfileDocument,
} from "@/lib/profile/collection";
import {
  isDuplicateKeyError,
  ProfileAlreadyExistsError,
  ProfileDataCorruptedError,
  ProfileError,
  ProfileNotFoundError,
  ProfileStoreError,
  ProfileStoreUnavailableError,
  ProfileValidationError,
} from "@/lib/profile/errors";
import {
  jobPreferencesSchema,
  resumeFileIdSchema,
  resumeProfileSchema,
  stripAbsentValues,
} from "@/lib/profile/schemas";
import type {
  JobProfileInput,
  StoredProfile,
  ValidationIssue,
} from "@/lib/profile/types";
import { getDb } from "@/lib/mongodb/client";

/**
 * Persistence for user profiles.
 *
 * Every write is validated before it reaches MongoDB, so an invalid payload can
 * never be persisted even if a caller forgets to validate first. Reads
 * re-validate what they find: a document that predates a schema change must be
 * reported as a server-side problem rather than served as if it were valid.
 *
 * Driver errors never reach the API. They are mapped to the safe errors in
 * `./errors`, with the original error kept as `cause` for server logs.
 */

type Database = Awaited<ReturnType<typeof getDb>>;

/** Shape of a document as stored, including the fields the API never accepts. */
const storedDocumentSchema = z.object({
  userId: z.string().min(1),
  resume: resumeProfileSchema,
  preferences: jobPreferencesSchema,
  resumeFileId: resumeFileIdSchema.optional(),
  parsedResumeFileId: resumeFileIdSchema.optional(),
  reviewedAt: z.date().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/** Converts a Zod failure into flat, path-addressed issues for the API. */
function toValidationIssues(error: z.ZodError, prefix?: string): ValidationIssue[] {
  return error.issues.map((issue) => {
    const segments = prefix === undefined ? issue.path.map(String) : [prefix, ...issue.path.map(String)];
    return { path: segments.join("."), message: issue.message };
  });
}

/**
 * Validates a submitted profile, throwing `ProfileValidationError` on failure.
 *
 * Issue paths are prefixed with `resume` or `preferences` so a client can map
 * them straight back onto the payload it submitted, even though each half is
 * validated against its own schema.
 *
 * The parse result is returned so callers persist the *normalized* values:
 * trimmed strings, deduplicated lists, defaulted collections.
 *
 * `resumeFileId` is accepted by the schema but never taken from a submitted
 * payload: only `POST /api/resume`, which has just written and validated the
 * file, may set the pointer, so a client cannot attach an id it did not upload.
 */
export function validateProfile(input: JobProfileInput) {
  const parsed = resumeProfileSchema.safeParse(input?.resume);
  if (!parsed.success) {
    throw new ProfileValidationError(toValidationIssues(parsed.error, "resume"));
  }

  const preferences = jobPreferencesSchema.safeParse(input?.preferences);
  if (!preferences.success) {
    throw new ProfileValidationError(toValidationIssues(preferences.error, "preferences"));
  }

  // Optional fields a caller left unanswered survive parsing as present-but-
  // `undefined` values. BSON turns those into `null` on write, which the stored
  // document schema rejects on read — so strip them here, at the one gate every
  // profile writer goes through.
  return {
    resume: stripAbsentValues(parsed.data),
    preferences: stripAbsentValues(preferences.data),
  };
}

/**
 * Maps a stored document to the shape the app consumes, converting BSON dates
 * to ISO strings. Throws if the stored data no longer matches the schema.
 */
function toStoredProfile(document: ProfileDocument): StoredProfile {
  const parsed = storedDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new ProfileDataCorruptedError(toValidationIssues(parsed.error));
  }

  return {
    userId: parsed.data.userId,
    resume: parsed.data.resume,
    preferences: parsed.data.preferences,
    ...(parsed.data.resumeFileId === undefined ? {} : { resumeFileId: parsed.data.resumeFileId }),
    ...(parsed.data.parsedResumeFileId === undefined
      ? {}
      : { parsedResumeFileId: parsed.data.parsedResumeFileId }),
    ...(parsed.data.reviewedAt === undefined ? {} : { reviewedAt: parsed.data.reviewedAt.toISOString() }),
    createdAt: parsed.data.createdAt.toISOString(),
    updatedAt: parsed.data.updatedAt.toISOString(),
  };
}

/** Walks an error's `cause` chain looking for a duplicate-key write failure. */
function causedByDuplicateKey(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (isDuplicateKeyError(current)) {
      return true;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return isDuplicateKeyError(error);
}

/**
 * Translates an unexpected error into a safe domain error. Domain errors are
 * passed through untouched so specific failures keep their message.
 */
function toSafeError(error: unknown): ProfileError {
  if (error instanceof ProfileError) {
    return error;
  }

  if (causedByDuplicateKey(error)) {
    return new ProfileAlreadyExistsError();
  }

  return new ProfileStoreError("The profile could not be read or written.", {
    cause: error,
  });
}

/**
 * Resolves the profiles collection, translating connection failures into a
 * safe "database unavailable" error.
 */
async function getProfilesCollection(): Promise<Collection<ProfileDocument>> {
  let db: Database;
  try {
    db = await getDb();
  } catch (error) {
    throw new ProfileStoreUnavailableError(undefined, { cause: error });
  }

  return db.collection<ProfileDocument>(PROFILES_COLLECTION);
}

/**
 * Runs a collection operation, translating driver failures into safe domain
 * errors while leaving already-safe errors (validation, corruption) intact.
 */
async function run<T>(operation: (collection: Collection<ProfileDocument>) => Promise<T>): Promise<T> {
  try {
    return await operation(await getProfilesCollection());
  } catch (error) {
    throw toSafeError(error);
  }
}

/**
 * Creates the profile for a user.
 *
 * `resumeFileId` is left unset: a profile can be created before a resume is
 * ever uploaded. Throws `ProfileAlreadyExistsError` if one already exists; the
 * unique index on `userId` is what actually enforces this, so a race between
 * two requests still cannot produce two profiles.
 *
 * `reviewedAt` is stamped here because the only caller is `PUT /api/profile`,
 * and every successful PUT is a person deliberately saving through Profile
 * Review. A profile that was just created and saved by its owner is not
 * "unreviewed".
 */
export async function createProfile(
  userId: string,
  input: JobProfileInput,
): Promise<StoredProfile> {
  const { resume, preferences } = validateProfile(input);

  const now = new Date();
  const document: ProfileDocument = {
    userId,
    resume,
    preferences,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await run(async (collection) => {
    await ensureProfileIndexes();
    await collection.insertOne(document);
  });

  return toStoredProfile(document);
}

/** Returns the user's profile, or `null` when they have not created one yet. */
export async function getProfileByUserId(userId: string): Promise<StoredProfile | null> {
  const document = await run((collection) => collection.findOne({ userId }));

  if (document === null) {
    return null;
  }

  return toStoredProfile(document);
}

/**
 * Replaces the resume and preferences of an existing profile.
 *
 * `createdAt` is never written back, so the record still reflects when the
 * profile was first created. `resumeFileId` and `parsedResumeFileId` are absent
 * from `$set` for the same reason as `createdAt` but with the opposite intent:
 * they are *preserved*, so saving profile text does not detach the profile from
 * its resume or lose track of which file the text came from.
 *
 * `reviewedAt` moves, though, because this function is how a person says "this
 * is my profile now". Later chats compare that stamp against the current resume
 * to decide whether the profile is settled or merely present.
 *
 * Throws `ProfileNotFoundError` when there is nothing to update; use
 * `createProfile` for the first write.
 */
export async function updateProfile(
  userId: string,
  input: JobProfileInput,
): Promise<StoredProfile> {
  const { resume, preferences } = validateProfile(input);
  const now = new Date();

  const updated = await run((collection) =>
    collection.findOneAndUpdate(
      { userId },
      { $set: { resume, preferences, reviewedAt: now, updatedAt: now } },
      { returnDocument: "after" },
    ),
  );

  if (updated === null) {
    throw new ProfileNotFoundError();
  }

  return toStoredProfile(updated);
}

/** What the parser knows it has produced, ready to be written to a profile. */
export type ParsedResumeWrite = {
  resume: JobProfileInput["resume"];
  preferences: JobProfileInput["preferences"];
  /** The resume upload the text was extracted from. */
  resumeFileId: string;
};

/**
 * Writes parser output into the user's profile, creating it if this is their
 * first resume.
 *
 * Upsert rather than insert-then-update, because parsing is the step that
 * creates a profile: a first-time user has nothing yet, and refusing to parse
 * until they had already built a profile would make the upload → parse → review
 * flow impossible to start. A single upsert also means two concurrent parses
 * cannot produce two profiles, without the caller having to catch a duplicate
 * key and retry.
 *
 * Three things are recorded together, and the difference between them is the
 * whole point of this function:
 *
 * - `resume` — the extracted text, replacing whatever was there. Re-parsing a
 *   corrected resume must not leave the old extraction in place.
 * - `resumeFileId` and `parsedResumeFileId` — both the file just parsed. After
 *   this returns they agree, which is what marks the profile as describing the
 *   current resume. They diverge only when the user uploads a new file without
 *   re-parsing, and that divergence is how staleness is detected.
 * - `reviewedAt` — cleared. Freshly extracted text has not been looked at by a
 *   person, and inheriting an earlier review stamp would claim otherwise.
 *
 * `preferences` is passed in rather than read here so the caller decides: the
 * parser preserves what the user already set and supplies empty preferences only
 * when it is creating the profile.
 *
 * `createdAt` is written on insert only and never afterwards.
 */
export async function saveParsedResumeProfile(
  userId: string,
  input: ParsedResumeWrite,
): Promise<StoredProfile> {
  const { resume, preferences } = validateProfile(input);

  const resumeFileId = resumeFileIdSchema.safeParse(input.resumeFileId);
  if (!resumeFileId.success) {
    throw new ProfileValidationError(toValidationIssues(resumeFileId.error, "resumeFileId"));
  }

  const now = new Date();

  const updated = await run(async (collection) => {
    await ensureProfileIndexes();

    return collection.findOneAndUpdate(
      { userId },
      {
        $set: {
          resume,
          preferences,
          resumeFileId: resumeFileId.data,
          parsedResumeFileId: resumeFileId.data,
          updatedAt: now,
        },
        $setOnInsert: { userId, createdAt: now },
        $unset: { reviewedAt: "" },
      },
      { upsert: true, returnDocument: "after" },
    );
  });

  if (updated === null) {
    throw new ProfileStoreError("The parsed profile could not be saved.");
  }

  return toStoredProfile(updated);
}

/**
 * Points an existing profile at an uploaded resume, returning `false` when the
 * user has no profile yet.
 *
 * This is the only writer of `resumeFileId` as a standalone change, and it is
 * deliberately separate from profile create/update and from the parse write, so
 * the pointer can only ever be set by a flow that has just stored a file.
 *
 * Replacing a resume does *not* discard the profile text. Someone's education
 * and work history is worth keeping even when it was extracted from the previous
 * file, and silently deleting a user's data on upload would be far worse than
 * labelling it as out of date. What this function does instead is move
 * `resumeFileId` while leaving `parsedResumeFileId` behind, which is precisely
 * the "this profile predates the current resume" signal. `reviewedAt` is cleared
 * for the same reason: that review happened against the old file.
 *
 * A missing profile is a `false` return rather than an error: uploading a
 * resume before building a profile is a normal order of operations, and the
 * upload itself is still a success. The caller decides whether that matters.
 */
export async function setProfileResumeFileId(
  userId: string,
  resumeFileId: string,
): Promise<boolean> {
  const parsed = resumeFileIdSchema.safeParse(resumeFileId);
  if (!parsed.success) {
    throw new ProfileValidationError(toValidationIssues(parsed.error, "resumeFileId"));
  }

  const now = new Date();
  const result = await run((collection) =>
    collection.updateOne(
      { userId },
      {
        $set: { resumeFileId: parsed.data, updatedAt: now },
        $unset: { reviewedAt: "" },
      },
    ),
  );

  return result.matchedCount > 0;
}