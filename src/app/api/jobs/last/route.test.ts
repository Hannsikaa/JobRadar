import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/jobs/last/route";
import type { DiscoveryScanDocument } from "@/lib/jobs/collection";
import { getLastScan } from "@/lib/jobs/discovery";
import type { JobSearchMetadata, NormalizedJob, SearchAttempt } from "@/lib/jobs/types";
import { USER_ID_HEADER } from "@/lib/identity/user-id";
import { ProfileStoreUnavailableError } from "@/lib/profile/errors";
import { getProfileByUserId } from "@/lib/profile/repository";
import { jobPreferencesSchema, resumeProfileSchema } from "@/lib/profile/schemas";
import type { StoredProfile } from "@/lib/profile/types";

vi.mock("@/lib/profile/repository", () => ({ getProfileByUserId: vi.fn() }));
vi.mock("@/lib/jobs/discovery", () => ({ getLastScan: vi.fn() }));

const mockedGetProfile = vi.mocked(getProfileByUserId);
const mockedGetLastScan = vi.mocked(getLastScan);

/**
 * Refresh-restore for the last scan.
 *
 * What these tests protect is the honesty rule, not the plumbing: a stored scan
 * may be shown again only while it still describes the profile on file. A
 * replaced resume or a later profile edit must yield `{ result: null }` — the
 * previous scan's jobs are *not* current, and serving them would put green
 * nodes under input they were never computed from. An absent or malformed
 * record is the same null, because "nothing to restore" is a 200, not an error.
 */

const profile: StoredProfile = {
  userId: "user-1",
  resume: resumeProfileSchema.parse({ name: "Ada" }),
  preferences: jobPreferencesSchema.parse({ targetRoles: ["Backend Engineer"] }),
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  resumeFileId: "file-1",
  reviewedAt: "2024-01-01T00:00:00.000Z",
};

const job: NormalizedJob = {
  id: "serpapi:j1",
  fingerprint: "fp1",
  title: "Backend Engineer",
  company: "Acme",
  location: "Berlin, Germany",
  source: "Google Jobs",
  isFresh: true,
  isNew: false,
  relevanceScore: 62,
  relevanceReasons: ["Skills overlap"],
};

const metadata: JobSearchMetadata = {
  total: 1,
  freshCount: 1,
  newCount: 1,
  salaryKnownCount: 0,
  belowMinimumCount: 0,
  unknownAgeCount: 0,
  searchedRoles: ["Backend Engineer"],
  searchedLocations: ["Berlin, Germany"],
  searchCount: 1,
  failedSearchCount: 0,
  rawCount: 3,
  duplicateCount: 2,
  freshnessDays: 7,
  experienceLevel: "entry",
  scannedAt: "2024-01-02T00:00:00.000Z",
  newTrackingAvailable: true,
};

const attempts: SearchAttempt[] = [
  { query: "Backend Engineer", location: "Berlin, Germany", role: "Backend Engineer", ok: true, resultCount: 3 },
];

function storedScan(overrides: Partial<DiscoveryScanDocument> = {}): DiscoveryScanDocument {
  return {
    userId: "user-1",
    scannedAt: new Date("2024-01-02T00:00:00.000Z"),
    total: 1,
    newCount: 1,
    searchedRoles: ["Backend Engineer"],
    searchedLocations: ["Berlin, Germany"],
    searchCount: 1,
    failedSearchCount: 0,
    newTrackingAvailable: true,
    jobs: [job],
    metadata,
    attempts,
    resumeFileId: "file-1",
    ...overrides,
  };
}

function getRequest(userId: string | null = "user-1"): Request {
  return new Request("https://app.test/api/jobs/last", {
    headers: userId === null ? {} : { [USER_ID_HEADER]: userId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("NODE_ENV", "test");

  mockedGetProfile.mockResolvedValue(profile);
  mockedGetLastScan.mockResolvedValue(storedScan());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/jobs/last", () => {
  it("restores the stored scan with no-store", async () => {
    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      result: { jobs: [job], metadata, attempts },
    });
  });

  it("looks both records up by the header user id", async () => {
    await GET(getRequest("user-9"));

    expect(mockedGetProfile).toHaveBeenCalledWith("user-9");
    expect(mockedGetLastScan).toHaveBeenCalledWith("user-9");
  });

  it("returns null when the resume the scan ran against was replaced", async () => {
    mockedGetProfile.mockResolvedValue({ ...profile, resumeFileId: "file-2" });

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: null });
  });

  it("returns null when the profile changed after the scan", async () => {
    // A re-parse or a re-save moves `updatedAt` past `scannedAt`; the stored
    // jobs were never scored against the newer profile.
    mockedGetProfile.mockResolvedValue({ ...profile, updatedAt: "2024-01-03T00:00:00.000Z" });

    const response = await GET(getRequest());

    expect(await response.json()).toEqual({ result: null });
  });

  it("returns null when no profile exists", async () => {
    mockedGetProfile.mockResolvedValue(null);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: null });
  });

  it("returns null when the user has never scanned", async () => {
    mockedGetLastScan.mockResolvedValue(null);

    const response = await GET(getRequest());

    expect(await response.json()).toEqual({ result: null });
  });

  it("returns null when the record predates restorable payloads", async () => {
    mockedGetLastScan.mockResolvedValue(
      storedScan({ jobs: undefined, metadata: undefined, attempts: undefined, resumeFileId: undefined })
    );

    const response = await GET(getRequest());

    expect(await response.json()).toEqual({ result: null });
  });

  it("returns null instead of forwarding a payload with malformed counts", async () => {
    // The client does arithmetic on these counts for node captions; a string
    // here would render "NaN/NaN searches" on a completed node.
    mockedGetLastScan.mockResolvedValue(
      storedScan({
        metadata: { ...metadata, total: "17" } as unknown as JobSearchMetadata,
      })
    );

    const response = await GET(getRequest());

    expect(await response.json()).toEqual({ result: null });
  });

  it("returns 401 for a malformed identity header", async () => {
    const response = await GET(getRequest("not a valid id"));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(mockedGetProfile).not.toHaveBeenCalled();
  });

  it("returns 503 when the profile store is unavailable", async () => {
    mockedGetProfile.mockRejectedValue(new ProfileStoreUnavailableError());

    const response = await GET(getRequest());

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("profile_unavailable");
  });

  it("returns 500 without leaking internals for an unexpected failure", async () => {
    mockedGetProfile.mockRejectedValue(new Error("mongodb://user:hunter2@host/profiles"));

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });
});
