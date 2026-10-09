import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/resume/route";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import { getCurrentResumeFileByUserId } from "@/lib/resume/repository";
import { uploadResume } from "@/lib/resume/service";
import type { StoredResumeFile } from "@/lib/resume/types";

/**
 * Route tests for `GET` and `POST /api/resume`.
 *
 * The route's only jobs are resolving identity, pulling the file out of the
 * multipart body, and translating errors into safe JSON. The upload flow itself
 * is stubbed, because `service.test.ts` covers it in detail.
 */

vi.mock("@/lib/identity/resolve-user-id", () => ({ resolveUserId: vi.fn() }));
vi.mock("@/lib/resume/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resume/repository")>();

  return { ...actual, getCurrentResumeFileByUserId: vi.fn() };
});
vi.mock("@/lib/resume/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resume/service")>();

  return { ...actual, uploadResume: vi.fn() };
});

const mockedResolveUserId = vi.mocked(resolveUserId);
const mockedGetCurrent = vi.mocked(getCurrentResumeFileByUserId);
const mockedUpload = vi.mocked(uploadResume);

const PDF_BODY = "%PDF-1.7\nbody\n";

/** A stored resume, including the two fields the API must never expose. */
const storedResume: StoredResumeFile = {
  id: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b",
  userId: "user-1",
  originalFilename: "Ada Lovelace - Resume.pdf",
  mimeType: "application/pdf",
  extension: "pdf",
  sizeBytes: PDF_BODY.length,
  storageKey: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b.pdf",
  uploadedAt: "2024-01-01T00:00:00.000Z",
};

/** Builds a multipart body exactly as a browser would submit it. */
function multipartBody(file?: File, field = "resume") {
  const form = new FormData();

  if (file !== undefined) {
    form.append(field, file);
  }

  return new Request("http://localhost/api/resume", { method: "POST", body: form });
}

/** A GET request carrying the identity header. */
function getRequest(userId = "user-1"): Request {
  return new Request("http://localhost/api/resume", {
    method: "GET",
    headers: { "x-job-radar-user-id": userId },
  });
}

function pdfFile(name = "Ada Lovelace - Resume.pdf") {
  return new File([new TextEncoder().encode(PDF_BODY)], name, { type: "application/pdf" });
}

function uploadSucceeds(replaced = false) {
  mockedUpload.mockResolvedValue({
    resume: {
      id: "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b",
      originalFilename: "Ada Lovelace - Resume.pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      sizeBytes: PDF_BODY.length,
      uploadedAt: "2024-01-01T00:00:00.000Z",
    },
    profileLinked: true,
    replaced,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveUserId.mockReturnValue("user-1");
  mockedGetCurrent.mockResolvedValue(null);
  uploadSucceeds();
});

describe("GET /api/resume", () => {
  it("answers 200 with the caller's current resume", async () => {
    mockedGetCurrent.mockResolvedValue(storedResume);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resume: expect.objectContaining({ id: storedResume.id, extension: "pdf" }),
    });
  });

  it("answers 200 with a null resume rather than 404 when there is none", async () => {
    mockedGetCurrent.mockResolvedValue(null);

    const response = await GET(getRequest());

    // "Is there a resume yet?" is a question about state, not a request for a
    // specific resource, so a first-time user gets 200 with nothing in it.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ resume: null });
  });

  it("passes the resolved identity to the repository", async () => {
    mockedResolveUserId.mockReturnValue("demo-abc");

    await GET(getRequest());

    expect(mockedGetCurrent).toHaveBeenCalledTimes(1);
    expect(mockedGetCurrent.mock.calls[0][0]).toBe("demo-abc");
  });

  it("never returns the storage key or the user id", async () => {
    mockedGetCurrent.mockResolvedValue(storedResume);

    const body = await (await GET(getRequest())).json();

    expect(body.resume).not.toHaveProperty("storageKey");
    expect(body.resume).not.toHaveProperty("userId");
  });

  it("marks the response no-store so metadata is never cached", async () => {
    const response = await GET(getRequest());

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 400 when the identity shim rejects the request", async () => {
    mockedResolveUserId.mockImplementation(() => {
      throw new Error("Missing required header: x-job-radar-user-id");
    });

    const response = await GET(getRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(mockedGetCurrent).not.toHaveBeenCalled();
  });

  it("does not leak the internal header name in the identity error body", async () => {
    mockedResolveUserId.mockImplementation(() => {
      throw new Error("connect ECONNREFUSED mongodb://10.0.0.5:27017 jobradar");
    });

    const raw = await (await GET(getRequest())).text();

    expect(raw).not.toContain("10.0.0.5");
    expect(raw).not.toContain("ECONNREFUSED");
  });

  it("maps a storage outage to 503", async () => {
    const { ResumeStorageUnavailableError } = await import("@/lib/resume/errors");
    mockedGetCurrent.mockRejectedValue(new ResumeStorageUnavailableError("The resume store is down."));

    const response = await GET(getRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "storage_unavailable" } });
  });
});

describe("POST /api/resume", () => {
  it("returns 201 with the resume and linkage state", async () => {
    const response = await POST(multipartBody(pdfFile()));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      resume: expect.objectContaining({ id: expect.any(String), extension: "pdf" }),
      profileLinked: true,
      replaced: false,
    });
  });

  it("reports a replacement so the caller knows the profile may be stale", async () => {
    uploadSucceeds(true);

    const body = await (await POST(multipartBody(pdfFile()))).json();

    expect(body.replaced).toBe(true);
  });

  it("marks the response no-store so metadata is never cached", async () => {
    const response = await POST(multipartBody(pdfFile()));

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes the resolved identity and the posted file to the service", async () => {
    const file = pdfFile();

    await POST(multipartBody(file));

    expect(mockedUpload).toHaveBeenCalledTimes(1);
    expect(mockedUpload.mock.calls[0][0]).toBe("user-1");
    expect(mockedUpload.mock.calls[0][1]).toBeInstanceOf(File);
  });

  it("never returns the storage key or the user id", async () => {
    const response = await POST(multipartBody(pdfFile()));
    const body = await response.json();

    expect(body.resume).not.toHaveProperty("storageKey");
    expect(body.resume).not.toHaveProperty("userId");
  });

  describe("request errors", () => {
    it("answers 400 when the body is not multipart", async () => {
      const request = new Request("http://localhost/api/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume: "base64" }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("answers 400 when no file is present at all", async () => {
      const response = await POST(multipartBody());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "missing_file" },
      });
    });

    it("answers 400 when the field is a plain string rather than a file", async () => {
      const form = new FormData();
      form.append("resume", "JVBERi0xLjQ=");

      const response = await POST(
        new Request("http://localhost/api/resume", { method: "POST", body: form }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "missing_file" },
      });
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("answers 400 when the identity shim rejects the request", async () => {
      mockedResolveUserId.mockImplementation(() => {
        throw new Error("Missing required header: x-job-radar-user-id");
      });

      const response = await POST(multipartBody(pdfFile()));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("does not leak the internal header name in the identity error body", async () => {
      mockedResolveUserId.mockImplementation(() => {
        throw new Error("connect ECONNREFUSED mongodb://10.0.0.5:27017 jobradar");
      });

      const response = await POST(multipartBody(pdfFile()));
      const raw = await response.text();

      expect(response.status).toBe(400);
      expect(raw).not.toContain("10.0.0.5");
      expect(raw).not.toContain("ECONNREFUSED");
    });
  });

  describe("upload failures", () => {
    it("maps a validation failure to 400 without inventing a new code", async () => {
      const { ResumeInvalidFileError } = await import("@/lib/resume/errors");
      mockedUpload.mockRejectedValue(new ResumeInvalidFileError("That file is not a readable PDF."));

      const response = await POST(multipartBody(pdfFile()));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_file" } });
    });

    it("maps an oversized file to 413", async () => {
      const { ResumeFileTooLargeError } = await import("@/lib/resume/errors");
      mockedUpload.mockRejectedValue(new ResumeFileTooLargeError());

      const response = await POST(multipartBody(pdfFile()));

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "file_too_large" } });
    });

    it("maps a storage outage to 503", async () => {
      const { ResumeStorageUnavailableError } = await import("@/lib/resume/errors");
      mockedUpload.mockRejectedValue(new ResumeStorageUnavailableError("The resume store is unavailable."));

      const response = await POST(multipartBody(pdfFile()));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "storage_unavailable" } });
    });

    it("maps an unknown failure to 500 without echoing its cause", async () => {
      const { ResumeUploadError } = await import("@/lib/resume/errors");
      mockedUpload.mockRejectedValue(
        new ResumeUploadError("The resume could not be saved.", {
          cause: new Error("EACCES: permission denied, open '/app/.data/resumes/abc.pdf'"),
        }),
      );

      const response = await POST(multipartBody(pdfFile()));
      const raw = await response.text();

      expect(response.status).toBe(500);
      // The body can only be read once, so the text is parsed rather than
      // re-requested as JSON.
      expect(JSON.parse(raw)).toMatchObject({ error: { code: "upload_failed" } });
      expect(raw).not.toContain("EACCES");
      expect(raw).not.toContain(".data");
    });

    it("never returns a stack trace", async () => {
      const { ResumeUploadError } = await import("@/lib/resume/errors");
      mockedUpload.mockRejectedValue(
        new ResumeUploadError("The resume could not be saved.", {
          cause: new Error("boom\n    at uploadResume (src/lib/resume/service.ts:101:12)"),
        }),
      );

      const raw = await (await POST(multipartBody(pdfFile()))).text();

      expect(raw).not.toContain("at uploadResume");
      expect(raw).not.toContain("service.ts");
    });
  });
});