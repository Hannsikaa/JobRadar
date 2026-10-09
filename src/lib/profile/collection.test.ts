import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureProfileIndexes,
  PROFILES_COLLECTION,
  USER_ID_INDEX_NAME,
  __resetProfileIndexes,
} from "@/lib/profile/collection";
import { getDb } from "@/lib/mongodb/client";

vi.mock("@/lib/mongodb/client", () => ({ getDb: vi.fn() }));

const mockedGetDb = vi.mocked(getDb);

function fakeDb(createIndex: ReturnType<typeof vi.fn>) {
  const collection = { createIndex };
  return { collection: vi.fn(() => collection) };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetProfileIndexes();
});

describe("profiles collection", () => {
  it("creates the unique userId index under a stable name", async () => {
    const createIndex = vi.fn(async () => "userId_unique");
    const db = fakeDb(createIndex);
    mockedGetDb.mockResolvedValue(db as unknown as Awaited<ReturnType<typeof getDb>>);

    await ensureProfileIndexes();

    expect(db.collection).toHaveBeenCalledWith(PROFILES_COLLECTION);
    expect(createIndex).toHaveBeenCalledWith(
      { userId: 1 },
      { unique: true, name: USER_ID_INDEX_NAME },
    );
  });

  it("does not touch the database at import time", () => {
    expect(mockedGetDb).not.toHaveBeenCalled();
  });

  it("initializes the index only once per process", async () => {
    const createIndex = vi.fn(async () => "userId_unique");
    mockedGetDb.mockResolvedValue(fakeDb(createIndex) as unknown as Awaited<
      ReturnType<typeof getDb>
    >);

    await ensureProfileIndexes();
    await ensureProfileIndexes();

    expect(createIndex).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure instead of caching the rejection", async () => {
    const createIndex = vi
      .fn()
      .mockRejectedValueOnce(new Error("index build failed"))
      .mockResolvedValueOnce("userId_unique");
    mockedGetDb.mockResolvedValue(fakeDb(createIndex) as unknown as Awaited<
      ReturnType<typeof getDb>
    >);

    await expect(ensureProfileIndexes()).rejects.toThrow("index build failed");
    await expect(ensureProfileIndexes()).resolves.toBeUndefined();
    expect(createIndex).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight attempt between concurrent callers", async () => {
    const createIndex = vi.fn(async () => "userId_unique");
    mockedGetDb.mockResolvedValue(fakeDb(createIndex) as unknown as Awaited<
      ReturnType<typeof getDb>
    >);

    await Promise.all([ensureProfileIndexes(), ensureProfileIndexes()]);

    expect(createIndex).toHaveBeenCalledTimes(1);
  });
});