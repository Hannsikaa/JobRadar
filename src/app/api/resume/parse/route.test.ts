import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/resume/parse/route";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import { parseResumeForUser } from "@/lib/resume/parser";

/**
 * Route tests for `POST /api/resume/parse`.
 *
 * The route's only jobs are resolving identity, reading the request body,
 * and translating errors into safe JSON. The parse flow itself is stubbed,
 * because `parser/index.test.ts` covers it in detail.
 */

vi.mock("@/lib/identity/resolve-user-id", () => ({ resolveUserId: vi.fn() }));
vi.mock("@/lib/resume/parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resume/parser")>();

  return { ...actual, parseResumeForUser: vi.fn() };
});

const mockedResolveUserId = vi.mocked(resolveUserId);
const mockedParse = vi.mocked(parseResumeForUser);

function jsonBody(body: unknown) {
  return new Request("http://localhost/api/resume/parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveUserId.mockReturnValue("user-1");
  mockedParse.mockResolvedValue({
    success: true,
    profile: {
      name: "John Doe",
      headline: undefined,
      summary: undefined,
      location: undefined,
      skills: ["TypeScript", "React"],
      technologies: [],
      languages: [],
      education: [],
      experience: [],
      projects: [],
      certifications: [],
    },
    warnings: [],
  });
});

describe("POST /api/resume/parse", () => {
  it("returns 200 with the parsed profile", async () => {
    const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      profile: expect.objectContaining({ name: "John Doe", skills: ["TypeScript", "React"] }),
      warnings: [],
    });
  });

  it("marks the response no-store so metadata is never cached", async () => {
    const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes the resolved identity and resumeFileId to the parser", async () => {
    await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

    expect(mockedParse).toHaveBeenCalledTimes(1);
    expect(mockedParse.mock.calls[0][0]).toBe("user-1");
    expect(mockedParse.mock.calls[0][1]).toBe("3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b");
  });

  describe("request errors", () => {
    it("answers 400 when the body is not valid JSON", async () => {
      const request = new Request("http://localhost/api/resume/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(mockedParse).not.toHaveBeenCalled();
    });

    it("answers 400 when the body is not an object", async () => {
      const request = new Request("http://localhost/api/resume/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("not an object"),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    });

    it("answers 400 when resumeFileId is missing", async () => {
      const response = await POST(jsonBody({}));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    });

    it("answers 400 when resumeFileId is empty", async () => {
      const response = await POST(jsonBody({ resumeFileId: "" }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    });

    it("answers 400 when the identity shim rejects the request", async () => {
      mockedResolveUserId.mockImplementation(() => {
        throw new Error("Missing required header: x-job-radar-user-id");
      });

      const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(mockedParse).not.toHaveBeenCalled();
    });

    it("does not leak internal details in the identity error body", async () => {
      mockedResolveUserId.mockImplementation(() => {
        throw new Error("connect ECONNREFUSED mongodb://10.0.0.5:27017 jobradar");
      });

      const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));
      const raw = await response.text();

      expect(response.status).toBe(400);
      expect(raw).not.toContain("10.0.0.5");
      expect(raw).not.toContain("ECONNREFUSED");
    });
  });

  describe("parse failures", () => {
    it("maps a not found error to 404", async () => {
      const { ResumeNotFoundError } = await import("@/lib/resume/parser/errors");
      mockedParse.mockRejectedValue(new ResumeNotFoundError());

      const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "no_resume_file" },
      });
    });

    it("maps a text extraction failure to 422", async () => {
      const { ResumeTextExtractionFailedError } = await import("@/lib/resume/parser/errors");
      mockedParse.mockRejectedValue(new ResumeTextExtractionFailedError("No text"));

      const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "resume_text_extraction_failed" },
      });
    });

    it("maps a parse failure to 422", async () => {
      const { ResumeParseFailedError } = await import("@/lib/resume/parser/errors");
      mockedParse.mockRejectedValue(new ResumeParseFailedError("Parse failed"));

      const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "resume_parse_failed" },
      });
    });

    it("maps a validation failure to 422", async () => {
      const { ResumeValidationFailedError } = await import("@/lib/resume/parser/errors");
      mockedParse.mockRejectedValue(new ResumeValidationFailedError("Invalid"));

      const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "resume_validation_failed" },
      });
    });

    it("maps a profile update failure to 500", async () => {
      const { ProfileUpdateFailedError } = await import("@/lib/resume/parser/errors");
      mockedParse.mockRejectedValue(new ProfileUpdateFailedError("Update failed"));

      const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "profile_update_failed" },
      });
    });

    it("maps an unknown failure to 500 without echoing its cause", async () => {
      mockedParse.mockRejectedValue(new Error("EACCES: permission denied"));

      const response = await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }));
      const raw = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(raw)).toMatchObject({ error: { code: "internal_error" } });
      expect(raw).not.toContain("EACCES");
    });

    it("never returns a stack trace", async () => {
      mockedParse.mockRejectedValue(new Error("boom\n    at parseResume (src/lib/resume/parser/index.ts:101:12)"));

      const raw = await (await POST(jsonBody({ resumeFileId: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b" }))).text();

      expect(raw).not.toContain("at parseResume");
      expect(raw).not.toContain("index.ts");
    });
  });
});