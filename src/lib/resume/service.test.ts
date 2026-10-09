import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResumeStorageError, ResumeUploadError } from "@/lib/resume/errors";
import { setProfileResumeFileId } from "@/lib/profile/repository";
import {
  deleteResumeFile,
  getCurrentResumeFileByUserId,
  insertResumeFile,
} from "@/lib/resume/repository";
import type { ResumeStorage } from "@/lib/resume/storage";
import type { StoredResumeFile } from "@/lib/resume/types";
import { toResumeUploadError, uploadResume } from "@/lib/resume/service";

/**
 * Tests for the upload flow's *ordering* and *rollback*.
 *
 * The service is the only place that knows the sequence
 * validate → read current → store bytes → store metadata → link profile, so these
 * tests use fakes rather than a temp directory: the point is that nothing is
 * written before it is needed, and everything written is undone when a later step
 * fails.
 */

vi.mock("@/lib/resume/repository", () => ({
  insertResumeFile: vi.fn(),
  deleteResumeFile: vi.fn(),
  getCurrentResumeFileByUserId: vi.fn(),
}));
vi.mock("@/lib/profile/repository", () => ({ setProfileResumeFileId: vi.fn() }));

const mockedInsert = vi.mocked(insertResumeFile);
const mockedDelete = vi.mocked(deleteResumeFile);
const mockedGetCurrent = vi.mocked(getCurrentResumeFileByUserId);
const mockedLink = vi.mocked(setProfileResumeFileId);

const USER_ID = "user-1";
const PDF_BODY = "%PDF-1.7\nbody\n";

/** An earlier upload by the same user, for the replacement cases. */
const PREVIOUS_ID = "11111111-2222-4333-8444-555555555555";

const previousResume: StoredResumeFile = {
  id: PREVIOUS_ID,
  userId: USER_ID,
  originalFilename: "Ada Lovelace - Older Resume.pdf",
  mimeType: "application/pdf",
  extension: "pdf",
  sizeBytes: 1024,
  storageKey: `${PREVIOUS_ID}.pdf`,
  uploadedAt: "2023-01-01T00:00:00.000Z",
};

function fakeStorage() {
  return {
    save: vi.fn<(key: string, data: Uint8Array) => Promise<void>>(async () => undefined),
    read: vi.fn<(key: string) => Promise<Uint8Array | null>>(async () => null),
    delete: vi.fn<(key: string) => Promise<void>>(async () => undefined),
  } satisfies ResumeStorage;
}

function pdfFile() {
  return new File([new TextEncoder().encode(PDF_BODY)], "Ada Lovelace - Resume.pdf", {
    type: "application/pdf",
  });
}

/** Mirrors the real repository by returning the document that was inserted. */
function useSuccessfulWrites() {
  mockedInsert.mockImplementation(async (document) => ({
    ...document,
    uploadedAt: document.uploadedAt.toISOString(),
  }));
  mockedDelete.mockResolvedValue(true);
  mockedGetCurrent.mockResolvedValue(null);
  mockedLink.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSuccessfulWrites();
});

describe("uploadResume", () => {
  it("stores the bytes under a generated uuid key", async () => {
    const storage = fakeStorage();
    const file = pdfFile();

    await uploadResume(USER_ID, file, { storage });

    expect(storage.save).toHaveBeenCalledTimes(1);
    const [key, bytes] = storage.save.mock.calls[0];
    expect(key).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(new TextDecoder().decode(bytes)).toBe(PDF_BODY);
  });

  it("writes the file before its metadata", async () => {
    const order: string[] = [];
    const storage = fakeStorage();
    storage.save.mockImplementation(async () => {
      order.push("save");
    });
    mockedInsert.mockImplementation(async (document) => {
      order.push("insert");
      return { ...document, uploadedAt: document.uploadedAt.toISOString() };
    });

    await uploadResume(USER_ID, pdfFile(), { storage });

    expect(order).toEqual(["save", "insert"]);
  });

  it("records the user, generated key, and size in metadata", async () => {
    const storage = fakeStorage();

    await uploadResume(USER_ID, pdfFile(), { storage });

    expect(mockedInsert).toHaveBeenCalledTimes(1);
    const document = mockedInsert.mock.calls[0][0];
    expect(document.userId).toBe(USER_ID);
    expect(document.extension).toBe("pdf");
    expect(document.sizeBytes).toBeGreaterThan(0);
    expect(document.storageKey).toBe(`${document.id}.pdf`);
    expect(document.uploadedAt).toBeInstanceOf(Date);
  });

  it("links the profile only after the metadata exists", async () => {
    const order: string[] = [];
    const storage = fakeStorage();
    mockedInsert.mockImplementation(async (document) => {
      order.push("insert");
      return { ...document, uploadedAt: document.uploadedAt.toISOString() };
    });
    mockedLink.mockImplementation(async () => {
      order.push("link");
      return true;
    });

    await uploadResume(USER_ID, pdfFile(), { storage });

    expect(order).toEqual(["insert", "link"]);
    expect(mockedLink).toHaveBeenCalledWith(USER_ID, mockedInsert.mock.calls[0][0].id);
  });

  it("returns public metadata without the storage key or user id", async () => {
    const storage = fakeStorage();

    const result = await uploadResume(USER_ID, pdfFile(), { storage });

    expect(result.profileLinked).toBe(true);
    expect(result.resume).toEqual({
      id: expect.any(String),
      originalFilename: "Ada Lovelace - Resume.pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      sizeBytes: PDF_BODY.length,
      uploadedAt: expect.any(String),
    });
    expect(result.resume).not.toHaveProperty("storageKey");
    expect(result.resume).not.toHaveProperty("userId");
  });

  it("succeeds with profileLinked false when no profile exists yet", async () => {
    const storage = fakeStorage();
    mockedLink.mockResolvedValue(false);

    const result = await uploadResume(USER_ID, pdfFile(), { storage });

    expect(result.profileLinked).toBe(false);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("never writes anything when validation fails", async () => {
    const storage = fakeStorage();
    const notAPdf = new File([new TextEncoder().encode("MZ\u0090\u0000binary")], "resume.pdf", {
      type: "application/pdf",
    });

    await expect(uploadResume(USER_ID, notAPdf, { storage })).rejects.toThrow();

    expect(storage.save).not.toHaveBeenCalled();
    expect(mockedInsert).not.toHaveBeenCalled();
    expect(mockedLink).not.toHaveBeenCalled();
  });

  describe("replacement", () => {
    it("reports replaced false for a first upload", async () => {
      const result = await uploadResume(USER_ID, pdfFile(), { storage: fakeStorage() });

      expect(result.replaced).toBe(false);
    });

    it("reports replaced true when the user already had a resume", async () => {
      mockedGetCurrent.mockResolvedValue(previousResume);

      const result = await uploadResume(USER_ID, pdfFile(), { storage: fakeStorage() });

      expect(result.replaced).toBe(true);
    });

    it("looks up the caller's current resume before writing anything", async () => {
      const storage = fakeStorage();
      const order: string[] = [];
      mockedGetCurrent.mockImplementation(async () => {
        order.push("read-current");
        return null;
      });
      storage.save.mockImplementation(async () => {
        order.push("save");
      });

      await uploadResume(USER_ID, pdfFile(), { storage });

      expect(mockedGetCurrent).toHaveBeenCalledWith(USER_ID);
      expect(order).toEqual(["read-current", "save"]);
    });

    it("writes nothing when the current-resume lookup fails", async () => {
      const storage = fakeStorage();
      const cause = new ResumeStorageError("mongodb read failed");
      mockedGetCurrent.mockRejectedValue(cause);

      // Decided before anything exists on disk, so there is no orphaned file to
      // clean up — the caller gets the failure directly.
      await expect(uploadResume(USER_ID, pdfFile(), { storage })).rejects.toBe(cause);

      expect(storage.save).not.toHaveBeenCalled();
      expect(mockedInsert).not.toHaveBeenCalled();
      expect(mockedLink).not.toHaveBeenCalled();
    });

    it("appends the new upload rather than replacing the stored row", async () => {
      mockedGetCurrent.mockResolvedValue(previousResume);

      await uploadResume(USER_ID, pdfFile(), { storage: fakeStorage() });

      // The previous file's metadata stays for rollback; "current" is a query,
      // not an overwrite.
      const newId = mockedInsert.mock.calls[0][0].id;
      expect(newId).not.toBe(PREVIOUS_ID);
      expect(mockedDelete).not.toHaveBeenCalled();
    });
  });

  describe("rollback", () => {
    it("deletes the file when the metadata insert fails", async () => {
      const storage = fakeStorage();
      const cause = new ResumeStorageError("mongodb write failed");
      mockedInsert.mockRejectedValue(cause);

      await expect(uploadResume(USER_ID, pdfFile(), { storage })).rejects.toBe(cause);

      expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(/\.pdf$/));
      expect(mockedLink).not.toHaveBeenCalled();
    });

    it("does not attempt a metadata delete when the insert never succeeded", async () => {
      const storage = fakeStorage();
      mockedInsert.mockRejectedValue(new ResumeStorageError("mongodb write failed"));

      await uploadResume(USER_ID, pdfFile(), { storage }).catch(() => undefined);

      expect(mockedDelete).not.toHaveBeenCalled();
    });

    it("undoes both the metadata and the file when linking fails", async () => {
      const storage = fakeStorage();
      const cause = new ResumeStorageError("profile update failed");
      mockedLink.mockRejectedValue(cause);

      await expect(uploadResume(USER_ID, pdfFile(), { storage })).rejects.toBe(cause);

      const id = mockedInsert.mock.calls[0][0].id;
      expect(mockedDelete).toHaveBeenCalledWith(id);
      expect(storage.delete).toHaveBeenCalledWith(`${id}.pdf`);
    });

    it("reports the original failure even when the cleanup also fails", async () => {
      const storage = fakeStorage();
      storage.delete.mockRejectedValue(new ResumeStorageError("delete failed"));
      mockedDelete.mockRejectedValue(new ResumeStorageError("delete failed"));
      const original = new ResumeStorageError("profile update failed");
      mockedLink.mockRejectedValue(original);

      await expect(uploadResume(USER_ID, pdfFile(), { storage })).rejects.toBe(original);
    });

    it("never overwrites an existing file when rolling back", async () => {
      const storage = fakeStorage();
      mockedLink.mockRejectedValue(new ResumeStorageError("profile update failed"));

      await uploadResume(USER_ID, pdfFile(), { storage }).catch(() => undefined);

      // One save, one delete: the rollback removes exactly what this call wrote.
      expect(storage.save).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete.mock.calls[0][0]).toBe(storage.save.mock.calls[0][0]);
    });
  });
});

describe("toResumeUploadError", () => {
  it("passes a domain error through unchanged", () => {
    const original = new ResumeStorageError("The resume file could not be stored.");

    expect(toResumeUploadError(original)).toBe(original);
  });

  it("wraps an unexpected error with a safe message and keeps the cause", () => {
    const cause = new Error("connect ECONNREFUSED 10.0.0.5:27017 /home/app/.data/resumes");

    const error = toResumeUploadError(cause);

    expect(error).toBeInstanceOf(ResumeUploadError);
    expect(error.message).toBe("The resume could not be saved.");
    expect(error.message).not.toContain("10.0.0.5");
    expect(error.message).not.toContain(".data");
    expect(error.cause).toBe(cause);
  });
});