import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDiscoveryIndexes } from "@/lib/jobs/collection";
import { readCachedDestination, writeCachedDestination } from "@/lib/jobs/official-cache";
import { getDb } from "@/lib/mongodb/client";

vi.mock("@/lib/mongodb/client", () => ({ getDb: vi.fn() }));

const mockedGetDb = vi.mocked(getDb);

/**
 * The destination cache is metering control, not a source of truth.
 *
 * These tests pin the two properties that keep it safe: an entry is only served
 * while it has not expired, and every Mongo failure degrades to "no cached
 * answer" rather than a thrown error that would break a scan.
 */

function fakeDb(collection: {
  findOne: ReturnType<typeof vi.fn>;
  updateOne: ReturnType<typeof vi.fn>;
}) {
  return {
    collection: vi.fn(() => ({
      createIndex: vi.fn(async () => "expiresAt_ttl"),
      findOne: collection.findOne,
      updateOne: collection.updateOne,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetDiscoveryIndexes();
});

describe("readCachedDestination", () => {
  it("serves a stored verified outcome", async () => {
    const findOne = vi.fn(async () => ({
      status: "verified_official_job",
      evidence: ["found"],
      destination: {
        url: "https://www.pinterestcareers.com/jobs/1/sw",
        kind: "official_company_site",
        provider: "pinterestcareers.com",
        evidence: ["Found on pinterestcareers.com."],
      },
      resolvedAt: new Date("2026-10-01T00:00:00.000Z"),
      expiresAt: new Date("2026-10-20T00:00:00.000Z"),
    }));
    mockedGetDb.mockResolvedValue(fakeDb({ findOne, updateOne: vi.fn() }) as never);

    const outcome = await readCachedDestination("pinterest|software engineer|", new Date("2026-10-09T00:00:00.000Z"));

    expect(outcome?.status).toBe("verified_official_job");
    expect(outcome?.destination?.provider).toBe("pinterestcareers.com");
  });

  it("only asks for entries that have not expired", async () => {
    const findOne = vi.fn(async () => null);
    mockedGetDb.mockResolvedValue(fakeDb({ findOne, updateOne: vi.fn() }) as never);

    await readCachedDestination("key", new Date("2026-10-09T12:00:00.000Z"));

    expect(findOne).toHaveBeenCalledWith({
      key: "key",
      expiresAt: { $gt: new Date("2026-10-09T12:00:00.000Z") },
    });
  });

  it("returns null instead of throwing when the database is down", async () => {
    mockedGetDb.mockRejectedValue(new Error("connection refused"));

    await expect(readCachedDestination("key", new Date())).resolves.toBeNull();
  });
});

describe("writeCachedDestination", () => {
  it("upserts the outcome with an expiry derived from the ttl", async () => {
    const updateOne = vi.fn(async () => ({ acknowledged: true }));
    mockedGetDb.mockResolvedValue(
      fakeDb({ findOne: vi.fn(async () => null), updateOne }) as never
    );

    await writeCachedDestination(
      "pinterest|software engineer|",
      {
        status: "verified_official_job",
        destination: {
          url: "https://www.pinterestcareers.com/jobs/1/sw",
          kind: "official_company_site",
          provider: "pinterestcareers.com",
          evidence: [],
        },
        evidence: [],
      },
      1000,
      new Date("2026-10-09T12:00:00.000Z")
    );

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0] ?? [];
    expect(filter).toEqual({ key: "pinterest|software engineer|" });
    expect(update?.$set?.expiresAt).toEqual(new Date("2026-10-09T12:00:01.000Z"));
  });

  it("swallows a write failure", async () => {
    mockedGetDb.mockRejectedValue(new Error("connection refused"));

    await expect(
      writeCachedDestination("key", { status: "no_employer_domain", evidence: [] }, 1000)
    ).resolves.toBeUndefined();
  });
});
