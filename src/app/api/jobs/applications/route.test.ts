import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/jobs/applications/route";
import { listAppliedJobIds, setJobApplied } from "@/lib/jobs/applications";
import { USER_ID_HEADER } from "@/lib/identity/user-id";

vi.mock("@/lib/jobs/applications", () => ({
  listAppliedJobIds: vi.fn(),
  setJobApplied: vi.fn(),
}));

const mockedList = vi.mocked(listAppliedJobIds);
const mockedSet = vi.mocked(setJobApplied);

/**
 * Application status endpoints.
 *
 * The tests pin the two behaviours that matter for trust: a per-user read that
 * never invents marks, and a write that fails loudly rather than silently
 * dropping the fact the user just set.
 */

function getRequest(userId: string | null = "user-1"): Request {
  return new Request("https://app.test/api/jobs/applications", {
    headers: userId === null ? {} : { [USER_ID_HEADER]: userId },
  });
}

function postRequest(body: unknown, userId: string | null = "user-1"): Request {
  return new Request("https://app.test/api/jobs/applications", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(userId === null ? {} : { [USER_ID_HEADER]: userId }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mockedList.mockResolvedValue({ available: true, appliedIds: new Set(["serpapi:1"]) });
  mockedSet.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/jobs/applications", () => {
  it("returns this user's applied ids", async () => {
    const response = await GET(getRequest());
    const body = (await response.json()) as { applied: string[]; available: boolean };

    expect(response.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith("user-1");
    expect(body).toEqual({ applied: ["serpapi:1"], available: true });
  });

  it("answers with an empty list when the store is unavailable", async () => {
    mockedList.mockResolvedValue({ available: false, appliedIds: new Set() });

    const body = (await (await GET(getRequest())).json()) as {
      applied: string[];
      available: boolean;
    };

    expect(body).toEqual({ applied: [], available: false });
  });

  it("refuses an anonymous caller in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(getRequest(null));

    expect(response.status).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });
});

describe("POST /api/jobs/applications", () => {
  it("marks a job applied for this user", async () => {
    const response = await POST(postRequest({ jobId: "serpapi:9", applied: true }));

    expect(response.status).toBe(200);
    expect(mockedSet).toHaveBeenCalledWith("user-1", "serpapi:9", true);
    expect(await response.json()).toEqual({ jobId: "serpapi:9", applied: true, available: true });
  });

  it("unmarks a job", async () => {
    await POST(postRequest({ jobId: "serpapi:9", applied: false }));

    expect(mockedSet).toHaveBeenCalledWith("user-1", "serpapi:9", false);
  });

  it("accepts a real SerpApi id, which is far longer than a slug", async () => {
    // Guard against a length cap set below what the pipeline actually emits:
    // SerpApi ids are a base64 blob and run past 700 characters.
    const realId = `serpapi:${"A".repeat(700)}`;

    const response = await POST(postRequest({ jobId: realId, applied: true }));

    expect(response.status).toBe(200);
    expect(mockedSet).toHaveBeenCalledWith("user-1", realId, true);
  });

  it("rejects a malformed body without writing", async () => {
    for (const body of [{}, { jobId: "", applied: true }, { jobId: "x" }, { jobId: "x", applied: "yes" }]) {
      const response = await POST(postRequest(body));
      expect(response.status).toBe(400);
    }

    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("reports a store failure as 503 so the client can revert", async () => {
    mockedSet.mockResolvedValue(false);

    const response = await POST(postRequest({ jobId: "serpapi:9", applied: true }));

    expect(response.status).toBe(503);
  });

  it("refuses an anonymous caller in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await POST(postRequest({ jobId: "x", applied: true }, null));

    expect(response.status).toBe(401);
    expect(mockedSet).not.toHaveBeenCalled();
  });
});
