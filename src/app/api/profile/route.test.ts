import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "@/app/api/profile/route";
import {
  ProfileAlreadyExistsError,
  ProfileNotFoundError,
  ProfileStoreUnavailableError,
  ProfileValidationError,
} from "@/lib/profile/errors";
import {
  createProfile,
  getProfileByUserId,
  updateProfile,
} from "@/lib/profile/repository";
import { USER_ID_HEADER } from "@/lib/identity/user-id";
import { jobPreferencesSchema, resumeProfileSchema } from "@/lib/profile/schemas";
import type { StoredProfile } from "@/lib/profile/types";

vi.mock("@/lib/profile/repository", () => ({
  createProfile: vi.fn(),
  getProfileByUserId: vi.fn(),
  updateProfile: vi.fn(),
}));

const mockedCreate = vi.mocked(createProfile);
const mockedGet = vi.mocked(getProfileByUserId);
const mockedUpdate = vi.mocked(updateProfile);

const validPayload = {
  resume: { name: "Ada" },
  preferences: { targetRoles: ["Backend Engineer"] },
};

/**
 * Built through the real schemas so the fixture is a genuinely normalized
 * profile — every defaulted array and field the repository would return.
 */
const storedProfile: StoredProfile = {
  userId: "local-user",
  resume: resumeProfileSchema.parse({ name: "Ada" }),
  preferences: jobPreferencesSchema.parse({ targetRoles: ["Backend Engineer"] }),
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function profileRequest(body: unknown, userId: string | null = null): Request {
  return new Request("https://app.test/api/profile", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(userId === null ? {} : { [USER_ID_HEADER]: userId }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/profile", () => {
  it("returns the stored profile with no-store", async () => {
    mockedGet.mockResolvedValue(storedProfile);

    const response = await GET(new Request("https://app.test/api/profile"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(storedProfile);
  });

  it("looks the profile up by the header user id", async () => {
    mockedGet.mockResolvedValue(storedProfile);

    await GET(
      new Request("https://app.test/api/profile", {
        headers: { [USER_ID_HEADER]: "  user-9 " },
      }),
    );

    expect(mockedGet).toHaveBeenCalledWith("user-9");
  });

  it("returns 404 with an error body when no profile exists", async () => {
    mockedGet.mockResolvedValue(null);

    const response = await GET(new Request("https://app.test/api/profile"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: { code: "not_found", message: "No profile exists for this user yet." },
    });
  });

  it("returns 400 in production when the identity header is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(new Request("https://app.test/api/profile"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed identity header", async () => {
    const response = await GET(
      new Request("https://app.test/api/profile", {
        headers: { [USER_ID_HEADER]: "not a valid id" },
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("returns 503 when the database is unavailable", async () => {
    mockedGet.mockRejectedValue(new ProfileStoreUnavailableError());

    const response = await GET(new Request("https://app.test/api/profile"));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("storage_unavailable");
  });
});

describe("PUT /api/profile", () => {
  it("creates a profile and returns 201", async () => {
    mockedCreate.mockResolvedValue(storedProfile);

    const response = await PUT(profileRequest(validPayload, "user-1"));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(storedProfile);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("updates instead of creating when a profile already exists", async () => {
    mockedCreate.mockRejectedValue(new ProfileAlreadyExistsError());
    mockedUpdate.mockResolvedValue(storedProfile);

    const response = await PUT(profileRequest(validPayload, "user-1"));

    expect(response.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith("user-1", validPayload);
  });

  it("returns 400 with issues when the profile is invalid", async () => {
    mockedCreate.mockRejectedValue(
      new ProfileValidationError([{ path: "resume.name", message: "Required" }]),
    );

    const response = await PUT(profileRequest({ resume: {}, preferences: {} }, "user-1"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      code: "validation",
      issues: [{ path: "resume.name", message: "Required" }],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const response = await PUT(profileRequest("{not json", "user-1"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toMatch(/valid JSON/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is valid JSON but not an object", async () => {
    for (const body of ["[]", '"text"', "null", "42"]) {
      const response = await PUT(profileRequest(body, "user-1"));

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(/JSON object/);
    }

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("passes the parsed payload through to the repository", async () => {
    mockedCreate.mockResolvedValue(storedProfile);

    await PUT(profileRequest(validPayload, "user-1"));

    expect(mockedCreate).toHaveBeenCalledWith("user-1", validPayload);
  });

  it("returns 404 when a concurrent delete leaves nothing to update", async () => {
    mockedCreate.mockRejectedValue(new ProfileAlreadyExistsError());
    mockedUpdate.mockRejectedValue(new ProfileNotFoundError());

    const response = await PUT(profileRequest(validPayload, "user-1"));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 500 without leaking internals for an unexpected failure", async () => {
    mockedCreate.mockRejectedValue(new Error("mongodb://user:hunter2@host/profiles"));

    const response = await PUT(profileRequest(validPayload, "user-1"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });
});