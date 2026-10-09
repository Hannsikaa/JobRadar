import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/mongodb/client";
import {
  RESUME_FILES_COLLECTION,
  RESUME_ID_INDEX_NAME,
  RESUME_USER_UPLOADED_INDEX_NAME,
  __resetResumeFileIndexes,
  ensureResumeFileIndexes,
} from "@/lib/resume/collection";

/**
 * Tests for resume index management.
 *
 * These run against a fake collection rather than a live database: what matters
 * here is *which* indexes are declared and how the once-per-process cache
 * behaves, both of which a real server would only reveal in production.
 */

vi.mock("@/lib/mongodb/client", () => ({ getDb: vi.fn() }));

const mockedGetDb = vi.mocked(getDb);

function useCollection() {
  const collection = {
    createIndex: vi.fn<
      (keys: Record<string, unknown>, options?: Record<string, unknown>) => Promise<string>
    >(async (_keys, options) => String(options?.name ?? "unnamed")),
  };
  const db = { collection: vi.fn(() => collection) };
  mockedGetDb.mockResolvedValue(db as unknown as Awaited<ReturnType<typeof getDb>>);

  return { collection, db };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The module caches the in-flight promise, so every case must start clean.
  __resetResumeFileIndexes();
});

describe("ensureResumeFileIndexes", () => {
  it("creates a unique index on the generated resume id", async () => {
    const { collection, db } = useCollection();

    await ensureResumeFileIndexes();

    expect(db.collection).toHaveBeenCalledWith(RESUME_FILES_COLLECTION);
    expect(collection.createIndex).toHaveBeenCalledWith(
      { id: 1 },
      { unique: true, name: RESUME_ID_INDEX_NAME },
    );
  });

  it("creates the index that lists a user's resumes newest-first", async () => {
    const { collection } = useCollection();

    await ensureResumeFileIndexes();

    expect(collection.createIndex).toHaveBeenCalledWith(
      { userId: 1, uploadedAt: -1 },
      { name: RESUME_USER_UPLOADED_INDEX_NAME },
    );
  });

  it("creates both indexes", async () => {
    const { collection } = useCollection();

    await ensureResumeFileIndexes();

    expect(collection.createIndex).toHaveBeenCalledTimes(2);
  });

  it("creates the indexes once per process, not once per request", async () => {
    const { collection } = useCollection();

    await Promise.all([ensureResumeFileIndexes(), ensureResumeFileIndexes()]);
    await ensureResumeFileIndexes();

    expect(collection.createIndex).toHaveBeenCalledTimes(2);
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failure to every caller waiting on it", async () => {
    const { collection } = useCollection();
    collection.createIndex.mockRejectedValue(new Error("index build failed"));

    const results = await Promise.allSettled([
      ensureResumeFileIndexes(),
      ensureResumeFileIndexes(),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    // Both callers shared one attempt rather than racing two.
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed attempt instead of caching the failure forever", async () => {
    const { collection } = useCollection();
    collection.createIndex.mockRejectedValueOnce(new Error("index build failed"));

    await expect(ensureResumeFileIndexes()).rejects.toThrow("index build failed");

    await expect(ensureResumeFileIndexes()).resolves.toBeUndefined();

    // One rejected attempt (id index) plus two successful ones.
    expect(collection.createIndex).toHaveBeenCalledTimes(3);
    expect(getDb).toHaveBeenCalledTimes(2);
  });

  it("does not touch the database when nothing asks for indexes", () => {
    useCollection();

    expect(getDb).not.toHaveBeenCalled();
  });
});