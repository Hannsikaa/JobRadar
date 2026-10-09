import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProfileAlreadyExistsError,
  ProfileDataCorruptedError,
  ProfileNotFoundError,
  ProfileStoreError,
  ProfileStoreUnavailableError,
  ProfileValidationError,
} from "@/lib/profile/errors";
import { createProfile, getProfileByUserId, saveParsedResumeProfile, setProfileResumeFileId, updateProfile } from "@/lib/profile/repository";
import type { JobPreferences, JobProfileInput, ResumeProfile } from "@/lib/profile/types";
import { getDb } from "@/lib/mongodb/client";

const { ensureProfileIndexes } = vi.hoisted(() => ({ ensureProfileIndexes: vi.fn() }));

vi.mock("@/lib/mongodb/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/profile/collection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile/collection")>()),
  ensureProfileIndexes,
}));

const mockedGetDb = vi.mocked(getDb);

const validInput = {
  resume: { name: "Ada", skills: [" TypeScript ", "TypeScript"] },
  preferences: { targetRoles: [" Backend Engineer "] },
};

/** The document the repository writes on insert: fully normalized, BSON dates. */
type InsertedDocument = {
  userId: string;
  resume: ResumeProfile;
  preferences: JobPreferences;
  createdAt: Date;
  updatedAt: Date;
};

/** The update document passed to `findOneAndUpdate`. */
type UpdatePayload = {
  $set: {
    resume: ResumeProfile;
    preferences: JobPreferences;
    resumeFileId?: string;
    parsedResumeFileId?: string;
    reviewedAt?: Date;
    updatedAt: Date;
  };
  $setOnInsert?: { userId: string; createdAt: Date };
  $unset?: Record<string, string>;
};

/** Signatures are declared so `mock.calls` stay typed without dummy parameters. */
type InsertResult = { acknowledged: true; insertedId: string };

function fakeCollection(overrides: Record<string, unknown> = {}) {
  return {
    insertOne: vi.fn<(document: InsertedDocument) => Promise<InsertResult>>(async () => ({
      acknowledged: true,
      insertedId: "id",
    })),
    findOne: vi.fn<(filter: Record<string, unknown>) => Promise<unknown>>(async () => null),
    findOneAndUpdate: vi.fn<
      (
        filter: Record<string, unknown>,
        update: UpdatePayload,
        options: Record<string, unknown>,
      ) => Promise<unknown>
    >(async () => null),
    updateOne: vi.fn<
      (
        filter: Record<string, unknown>,
        update: UpdatePayload,
      ) => Promise<{ matchedCount: number; modifiedCount: number }>
    >(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    ...overrides,
  };
}

type FakeCollection = ReturnType<typeof fakeCollection>;

function useCollection(collection: FakeCollection) {
  const db = { collection: vi.fn(() => collection) };
  mockedGetDb.mockResolvedValue(db as unknown as Awaited<ReturnType<typeof getDb>>);
  return db;
}

function duplicateKeyError() {
  return Object.assign(new Error("E11000 duplicate key error collection profiles"), { code: 11000 });
}

function storedDocument(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    resume: { name: "Ada" },
    preferences: { targetRoles: ["Backend"] },
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureProfileIndexes.mockResolvedValue(undefined);
});

describe("createProfile", () => {
  it("persists normalized values and returns ISO string timestamps", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    const stored = await createProfile("user-1", validInput);

    expect(collection.insertOne).toHaveBeenCalledTimes(1);
    const [document] = collection.insertOne.mock.calls[0]!;
    expect(document.userId).toBe("user-1");
    expect(document.resume.skills).toEqual(["TypeScript"]);
    expect(document.preferences.targetRoles).toEqual(["Backend Engineer"]);
    expect(document.preferences).toMatchObject({ experienceLevel: "mid", freshnessDays: 7 });
    expect(document.createdAt).toBeInstanceOf(Date);
    expect(document.updatedAt).toBeInstanceOf(Date);
    expect(document.reviewedAt).toBeInstanceOf(Date);

    expect(stored).toMatchObject({ userId: "user-1" });
    expect(stored.createdAt).toBe(document.createdAt.toISOString());
    expect(stored.updatedAt).toBe(document.updatedAt.toISOString());
    expect(stored.reviewedAt).toBe(document.reviewedAt!.toISOString());
  });

  it("ensures the unique index before writing", async () => {
    const order: string[] = [];
    ensureProfileIndexes.mockImplementation(async () => {
      order.push("index");
    });
    const collection = fakeCollection({
      insertOne: vi.fn(async () => {
        order.push("insert");
        return { acknowledged: true, insertedId: "id" };
      }),
    });
    useCollection(collection);

    await createProfile("user-1", validInput);

    expect(ensureProfileIndexes).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["index", "insert"]);
  });

  it("stores a clean document when optional fields arrive as undefined", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    const input = {
      resume: {
        name: "Ada",
        headline: undefined,
        summary: undefined,
        skills: ["TypeScript"],
        projects: [{ name: "Radar", link: undefined }],
      },
      preferences: { targetRoles: ["Backend Engineer"] },
    } as unknown as JobProfileInput;

    await createProfile("user-1", input);

    const [document] = collection.insertOne.mock.calls[0]!;
    expect(document.resume).not.toHaveProperty("headline");
    expect(document.resume).not.toHaveProperty("summary");
    expect(document.resume.projects[0]).not.toHaveProperty("link");
    // The stored document must survive its own read-back validation, which would
    // reject any nullish value for those optional fields.
    expect(JSON.stringify(document)).not.toContain("null");
  });

  it("rejects an invalid profile before touching the database", async () => {
    const collection = fakeCollection();
    const db = useCollection(collection);

    await expect(
      createProfile("user-1", { resume: { name: "  " }, preferences: { targetRoles: [] } }),
    ).rejects.toBeInstanceOf(ProfileValidationError);

    expect(db.collection).not.toHaveBeenCalled();
    expect(collection.insertOne).not.toHaveBeenCalled();
  });

  it("reports issue paths relative to the submitted payload", async () => {
    useCollection(fakeCollection());

    // Intentionally invalid: the input type cannot express a missing title, so
    // the payload is cast to reach the runtime validation path.
    const invalid = {
      resume: { name: "Ada", experience: [{ company: "Acme" }] },
      preferences: { targetRoles: ["Backend"] },
    } as unknown as JobProfileInput;

    const error = await createProfile("user-1", invalid).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProfileValidationError);
    expect((error as ProfileValidationError).issues[0]?.path).toBe("resume.experience.0.title");
  });

  it("maps a duplicate key error to an already-exists error", async () => {
    useCollection(
      fakeCollection({
        insertOne: vi.fn(async () => {
          throw duplicateKeyError();
        }),
      }),
    );

    await expect(createProfile("user-1", validInput)).rejects.toBeInstanceOf(
      ProfileAlreadyExistsError,
    );
  });

  it("maps other driver failures to a storage error without leaking the cause", async () => {
    const cause = new Error("connection reset by peer");
    useCollection(
      fakeCollection({
        insertOne: vi.fn(async () => {
          throw cause;
        }),
      }),
    );

    const error = await createProfile("user-1", validInput).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProfileStoreError);
    expect((error as ProfileStoreError).message).not.toContain("connection reset");
    expect((error as ProfileStoreError).cause).toBe(cause);
  });

  it("maps a connection failure to an unavailable error", async () => {
    mockedGetDb.mockRejectedValue(new Error("MONGODB_URI is not configured"));

    await expect(createProfile("user-1", validInput)).rejects.toBeInstanceOf(
      ProfileStoreUnavailableError,
    );
  });
});

describe("getProfileByUserId", () => {
  it("returns null when no profile exists", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    await expect(getProfileByUserId("user-1")).resolves.toBeNull();
    expect(collection.findOne).toHaveBeenCalledWith({ userId: "user-1" });
  });

  it("converts stored dates to ISO strings", async () => {
    useCollection(
      fakeCollection({ findOne: vi.fn(async () => storedDocument()) }),
    );

    const stored = await getProfileByUserId("user-1");

    expect(stored?.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(stored?.updatedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("treats a document that no longer matches the schema as corrupted", async () => {
    useCollection(
      fakeCollection({
        findOne: vi.fn(async () => storedDocument({ resume: { name: "" } })),
      }),
    );

    await expect(getProfileByUserId("user-1")).rejects.toBeInstanceOf(
      ProfileDataCorruptedError,
    );
  });
});

describe("updateProfile", () => {
  it("writes resume, preferences, reviewedAt, and updatedAt but never createdAt", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    await expect(updateProfile("user-1", validInput)).rejects.toBeInstanceOf(
      ProfileNotFoundError,
    );

    const [filter, update, options] = collection.findOneAndUpdate.mock.calls[0]!;
    expect(filter).toEqual({ userId: "user-1" });
    // Exact keys, so adding another field to this write has to be a deliberate
    // decision rather than something that slips in unnoticed.
    expect(Object.keys(update)).toEqual(["$set"]);
    expect(Object.keys(update.$set).sort()).toEqual([
      "preferences",
      "resume",
      "reviewedAt",
      "updatedAt",
    ]);
    expect(update.$set).not.toHaveProperty("createdAt");
    // Provenance pointers are preserved, never overwritten by a text save.
    expect(update.$set).not.toHaveProperty("resumeFileId");
    expect(update.$set).not.toHaveProperty("parsedResumeFileId");
    expect(update.$set.reviewedAt).toBeInstanceOf(Date);
    expect(options).toEqual({ returnDocument: "after" });
  });

  it("returns the updated document", async () => {
    useCollection(
      fakeCollection({
        findOneAndUpdate: vi.fn(async () =>
          storedDocument({ updatedAt: new Date("2025-02-02T00:00:00.000Z") }),
        ),
      }),
    );

    const stored = await updateProfile("user-1", validInput);

    expect(stored.updatedAt).toBe("2025-02-02T00:00:00.000Z");
    expect(stored.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });
});

const RESUME_FILE_ID = "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b";

describe("saveParsedResumeProfile", () => {
  const parsedWrite = {
    resume: { name: "Ada", skills: [" TypeScript ", "TypeScript"] },
    preferences: { targetRoles: [] },
    resumeFileId: RESUME_FILE_ID,
  };

  it("upserts so a first-time user gets a profile instead of an error", async () => {
    const collection = fakeCollection({
      findOneAndUpdate: vi.fn(async () => storedDocument({ resumeFileId: RESUME_FILE_ID })),
    });
    useCollection(collection);

    await saveParsedResumeProfile("user-1", parsedWrite);

    const [, , options] = collection.findOneAndUpdate.mock.calls[0]!;
    expect(options).toEqual({ upsert: true, returnDocument: "after" });
  });

  it("records both provenance pointers so the profile reads as current", async () => {
    const collection = fakeCollection({
      findOneAndUpdate: vi.fn(async () => storedDocument({ resumeFileId: RESUME_FILE_ID })),
    });
    useCollection(collection);

    await saveParsedResumeProfile("user-1", parsedWrite);

    const [, update] = collection.findOneAndUpdate.mock.calls[0]!;
    // Agreeing pointers are exactly the "this text came from this file" signal.
    expect(update.$set.resumeFileId).toBe(RESUME_FILE_ID);
    expect(update.$set.parsedResumeFileId).toBe(RESUME_FILE_ID);
  });

  it("clears reviewedAt because nobody has looked at freshly parsed text", async () => {
    const collection = fakeCollection({
      findOneAndUpdate: vi.fn(async () => storedDocument({ resumeFileId: RESUME_FILE_ID })),
    });
    useCollection(collection);

    await saveParsedResumeProfile("user-1", parsedWrite);

    const [, update] = collection.findOneAndUpdate.mock.calls[0]!;
    expect(update.$unset).toEqual({ reviewedAt: "" });
    expect(update.$set).not.toHaveProperty("reviewedAt");
  });

  it("sets createdAt on insert only and never overwrites it", async () => {
    const collection = fakeCollection({
      findOneAndUpdate: vi.fn(async () => storedDocument({ resumeFileId: RESUME_FILE_ID })),
    });
    useCollection(collection);

    await saveParsedResumeProfile("user-1", parsedWrite);

    const [, update] = collection.findOneAndUpdate.mock.calls[0]!;
    expect(update.$setOnInsert).toEqual({ userId: "user-1", createdAt: expect.any(Date) });
    expect(update.$set).not.toHaveProperty("createdAt");
  });

  it("replaces the stored resume text rather than merging into it", async () => {
    const collection = fakeCollection({
      findOneAndUpdate: vi.fn(async () => storedDocument({ resumeFileId: RESUME_FILE_ID })),
    });
    useCollection(collection);

    await saveParsedResumeProfile("user-1", parsedWrite);

    const [, update] = collection.findOneAndUpdate.mock.calls[0]!;
    // Normalized, so a re-parsed resume cannot leave the old extraction behind.
    expect(update.$set.resume).toMatchObject({ name: "Ada", skills: ["TypeScript"] });
  });

  it("drops undefined optional fields so BSON cannot turn them into null", async () => {
    const collection = fakeCollection({
      findOneAndUpdate: vi.fn(async () => storedDocument({ resumeFileId: RESUME_FILE_ID })),
    });
    useCollection(collection);

    // This is the exact shape the resume parser produces: optional text fields
    // are present-but-`undefined`. MongoDB serializes those into `null`, which
    // the stored document schema rejects on read — bricking the profile.
    await saveParsedResumeProfile("user-1", {
      resume: {
        name: "Ada",
        headline: undefined,
        location: undefined,
        skills: ["TypeScript"],
        experience: [{ title: "Engineer", company: "X", location: undefined }],
      },
      preferences: { targetRoles: [] },
      resumeFileId: RESUME_FILE_ID,
    });

    const [, update] = collection.findOneAndUpdate.mock.calls[0]!;
    expect(update.$set.resume).not.toHaveProperty("headline");
    expect(update.$set.resume).not.toHaveProperty("location");
    expect(update.$set.resume.experience[0]).not.toHaveProperty("location");
    // Nothing nullish may reach MongoDB, or the stored document schema rejects
    // the profile on every later read.
    expect(JSON.stringify(update.$set)).not.toContain("null");
  });

  it("accepts empty target roles so the parser can create a profile", async () => {
    const collection = fakeCollection({
      findOneAndUpdate: vi.fn(async () => storedDocument({ resumeFileId: RESUME_FILE_ID })),
    });
    useCollection(collection);

    // The point is that this call succeeds at all: the parser cannot know target
    // roles, so refusing to write would deadlock the upload → parse → review flow.
    await expect(saveParsedResumeProfile("user-1", parsedWrite)).resolves.toBeDefined();

    const [, update] = collection.findOneAndUpdate.mock.calls[0]!;
    expect(update.$set.preferences.targetRoles).toEqual([]);
  });

  it("rejects a resume file id that is not a uuid", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    await expect(
      saveParsedResumeProfile("user-1", { ...parsedWrite, resumeFileId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ProfileValidationError);
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reports a failed upsert rather than returning a profile that was not stored", async () => {
    useCollection(
      fakeCollection({
        findOneAndUpdate: vi.fn(async () => null),
      }),
    );

    await expect(saveParsedResumeProfile("user-1", parsedWrite)).rejects.toBeInstanceOf(
      ProfileStoreError,
    );
  });
});

describe("setProfileResumeFileId", () => {
  it("reports false when the user has no profile to link", async () => {
    useCollection(
      fakeCollection({
        updateOne: vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
      }),
    );

    await expect(setProfileResumeFileId("user-1", RESUME_FILE_ID)).resolves.toBe(false);
  });

  it("reports true once the pointer has moved", async () => {
    useCollection(
      fakeCollection({
        updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      }),
    );

    await expect(setProfileResumeFileId("user-1", RESUME_FILE_ID)).resolves.toBe(true);
  });

  it("moves the pointer and clears reviewedAt so a replacement reads as stale", async () => {
    const collection = fakeCollection({
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    });
    useCollection(collection);

    await setProfileResumeFileId("user-1", RESUME_FILE_ID);

    const [filter, update] = collection.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ userId: "user-1" });
    // `parsedResumeFileId` is deliberately left alone: the divergence between the
    // two pointers is how staleness is detected.
    expect(update.$set.resumeFileId).toBe(RESUME_FILE_ID);
    expect(update.$set).not.toHaveProperty("parsedResumeFileId");
    expect(update.$unset).toEqual({ reviewedAt: "" });
  });

  it("never discards the profile text when a resume is replaced", async () => {
    const collection = fakeCollection({
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    });
    useCollection(collection);

    await setProfileResumeFileId("user-1", RESUME_FILE_ID);

    const [, update] = collection.updateOne.mock.calls[0]!;
    expect(update.$set).not.toHaveProperty("resume");
    expect(update.$unset).not.toHaveProperty("resume");
  });

  it("refuses a pointer that is not a uuid", async () => {
    const collection = fakeCollection({
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    });
    useCollection(collection);

    await expect(setProfileResumeFileId("user-1", "not-a-uuid")).rejects.toBeInstanceOf(
      ProfileValidationError,
    );
    expect(collection.updateOne).not.toHaveBeenCalled();
  });
});