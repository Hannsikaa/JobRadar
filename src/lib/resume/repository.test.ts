import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/mongodb/client";
import {
  RESUME_ID_INDEX_NAME,
  RESUME_USER_UPLOADED_INDEX_NAME,
  type ResumeFileDocument,
} from "@/lib/resume/collection";
import { ResumeStorageError, ResumeStorageUnavailableError } from "@/lib/resume/errors";
import { deleteResumeFile, getCurrentResumeFileByUserId, getResumeFileById, insertResumeFile } from "@/lib/resume/repository";

const { ensureResumeFileIndexes } = vi.hoisted(() => ({ ensureResumeFileIndexes: vi.fn() }));

vi.mock("@/lib/mongodb/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/resume/collection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resume/collection")>()),
  ensureResumeFileIndexes,
}));

const mockedGetDb = vi.mocked(getDb);

const ID = "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b";

function document(overrides: Partial<ResumeFileDocument> = {}): ResumeFileDocument {
  return {
    id: ID,
    userId: "user-1",
    originalFilename: "Ada Lovelace - Resume.pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    sizeBytes: 1024,
    storageKey: `${ID}.pdf`,
    uploadedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeCollection(overrides: Record<string, unknown> = {}) {
  return {
    insertOne: vi.fn<(document: ResumeFileDocument) => Promise<{ acknowledged: true }>>(
      async () => ({ acknowledged: true }),
    ),
    findOne: vi.fn<(filter: Record<string, unknown>) => Promise<unknown>>(async () => null),
    deleteOne: vi.fn<(filter: Record<string, unknown>) => Promise<{ deletedCount: number }>>(
      async () => ({ deletedCount: 1 }),
    ),
    ...overrides,
  };
}

type FakeCollection = ReturnType<typeof fakeCollection>;

function useCollection(collection: FakeCollection) {
  const db = { collection: vi.fn(() => collection) };
  mockedGetDb.mockResolvedValue(db as unknown as Awaited<ReturnType<typeof getDb>>);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureResumeFileIndexes.mockResolvedValue(undefined);
});

describe("resume collection definitions", () => {
  it("keeps the collection and index names stable for future lookups", () => {
    expect(RESUME_ID_INDEX_NAME).toBe("id_unique");
    expect(RESUME_USER_UPLOADED_INDEX_NAME).toBe("userId_uploadedAt");
  });
});

describe("insertResumeFile", () => {
  it("writes the document and returns it with an ISO timestamp", async () => {
    const collection = fakeCollection();
    useCollection(collection);
    const input = document();

    const stored = await insertResumeFile(input);

    expect(collection.insertOne).toHaveBeenCalledWith(input);
    expect(stored).toEqual({ ...input, uploadedAt: "2024-01-01T00:00:00.000Z" });
    expect(typeof stored.uploadedAt).toBe("string");
  });

  it("ensures the unique id index before writing", async () => {
    const order: string[] = [];
    ensureResumeFileIndexes.mockImplementation(async () => {
      order.push("index");
    });
    const collection = fakeCollection({
      insertOne: vi.fn(async () => {
        order.push("insert");
        return { acknowledged: true };
      }),
    });
    useCollection(collection);

    await insertResumeFile(document());

    expect(ensureResumeFileIndexes).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["index", "insert"]);
  });

  it("maps a driver failure to a storage error without leaking the cause", async () => {
    const cause = new Error("mongodb://user:hunter2@host/resumeFiles write failed");
    useCollection(
      fakeCollection({
        insertOne: vi.fn(async () => {
          throw cause;
        }),
      }),
    );

    const error = await insertResumeFile(document()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ResumeStorageError);
    expect((error as ResumeStorageError).status).toBe(500);
    expect((error as ResumeStorageError).message).not.toContain("hunter2");
    expect((error as ResumeStorageError).cause).toBe(cause);
  });

  it("maps a connection failure to an unavailable error", async () => {
    mockedGetDb.mockRejectedValue(new Error("MONGODB_URI is not configured"));

    const error = await insertResumeFile(document()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ResumeStorageUnavailableError);
    expect((error as ResumeStorageUnavailableError).status).toBe(503);
    expect((error as ResumeStorageUnavailableError).message).not.toContain("MONGODB_URI");
  });

  it("refuses to return a document that does not match the stored schema", async () => {
    useCollection(fakeCollection());

    const invalid = document({ id: "not-a-uuid" }) as unknown as ResumeFileDocument;

    await expect(insertResumeFile(invalid)).rejects.toBeInstanceOf(ResumeStorageError);
  });
});

describe("getResumeFileById", () => {
  it("returns null when no resume exists", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    await expect(getResumeFileById(ID)).resolves.toBeNull();
    expect(collection.findOne).toHaveBeenCalledWith({ id: ID });
  });

  it("converts the stored date to an ISO string", async () => {
    useCollection(fakeCollection({ findOne: vi.fn(async () => document()) }));

    const stored = await getResumeFileById(ID);

    expect(stored?.uploadedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("reports a corrupted document instead of returning partial data", async () => {
    useCollection(fakeCollection({ findOne: vi.fn(async () => document({ sizeBytes: -1 })) }));

    await expect(getResumeFileById(ID)).rejects.toBeInstanceOf(ResumeStorageError);
  });
});

describe("getCurrentResumeFileByUserId", () => {
  it("returns null when the user has never uploaded a resume", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    await expect(getCurrentResumeFileByUserId("user-1")).resolves.toBeNull();
  });

  it("asks for the user's newest upload, served by the userId_uploadedAt index", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    await getCurrentResumeFileByUserId("user-1");

    expect(collection.findOne).toHaveBeenCalledWith(
      { userId: "user-1" },
      { sort: { uploadedAt: -1 } },
    );
  });

  it("returns the newest document with an ISO timestamp", async () => {
    useCollection(fakeCollection({ findOne: vi.fn(async () => document()) }));

    const stored = await getCurrentResumeFileByUserId("user-1");

    expect(stored?.id).toBe(ID);
    expect(stored?.uploadedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("only ever asks about the given user", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    await getCurrentResumeFileByUserId("demo-abc");

    expect(collection.findOne.mock.calls[0][0]).toEqual({ userId: "demo-abc" });
  });

  it("reports a corrupted document instead of returning partial data", async () => {
    useCollection(
      fakeCollection({ findOne: vi.fn(async () => document({ storageKey: "" })) }),
    );

    await expect(getCurrentResumeFileByUserId("user-1")).rejects.toBeInstanceOf(ResumeStorageError);
  });

  it("maps a connection failure to an unavailable error", async () => {
    mockedGetDb.mockRejectedValue(new Error("MONGODB_URI is not configured"));

    await expect(getCurrentResumeFileByUserId("user-1")).rejects.toBeInstanceOf(
      ResumeStorageUnavailableError,
    );
  });
});

describe("deleteResumeFile", () => {
  it("returns true when a document was removed", async () => {
    const collection = fakeCollection();
    useCollection(collection);

    await expect(deleteResumeFile(ID)).resolves.toBe(true);
    expect(collection.deleteOne).toHaveBeenCalledWith({ id: ID });
  });

  it("returns false when there was nothing to remove", async () => {
    useCollection(fakeCollection({ deleteOne: vi.fn(async () => ({ deletedCount: 0 })) }));

    await expect(deleteResumeFile(ID)).resolves.toBe(false);
  });

  it("propagates failures so the service decides whether to discard them", async () => {
    useCollection(
      fakeCollection({
        deleteOne: vi.fn(async () => {
          throw new Error("delete failed");
        }),
      }),
    );

    await expect(deleteResumeFile(ID)).rejects.toBeInstanceOf(ResumeStorageError);
  });
});