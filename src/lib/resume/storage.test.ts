import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildStorageKey,
  createLocalResumeStorage,
  DEFAULT_RESUME_STORAGE_DIR,
  isSafeStorageKey,
  type ResumeStorage,
} from "@/lib/resume/storage";
import { ResumeStorageError } from "@/lib/resume/errors";

/**
 * Tests for the local storage adapter.
 *
 * These use a real temporary directory rather than mocking `node:fs`, because
 * the behaviour worth pinning here is filesystem behaviour: exact bytes, no
 * overwrite on collision, idempotent delete, and refusing keys that would
 * escape the root.
 */

const ID = "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b";
const PDF_KEY = `${ID}.pdf`;

let root: string;
let storage: ResumeStorage;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "job-radar-resume-"));
  storage = createLocalResumeStorage(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildStorageKey", () => {
  it("joins the generated id and the extension", () => {
    expect(buildStorageKey(ID, "pdf")).toBe(PDF_KEY);
    expect(buildStorageKey(ID, "docx")).toBe(`${ID}.docx`);
  });
});

describe("isSafeStorageKey", () => {
  it("accepts a generated uuid key for a supported extension", () => {
    expect(isSafeStorageKey(PDF_KEY)).toBe(true);
    expect(isSafeStorageKey(`${ID}.docx`)).toBe(true);
  });

  it("rejects an unsupported extension", () => {
    expect(isSafeStorageKey(`${ID}.exe`)).toBe(false);
    expect(isSafeStorageKey(`${ID}.html`)).toBe(false);
  });

  it("rejects a key that is not a bare uuid", () => {
    expect(isSafeStorageKey("resume.pdf")).toBe(false);
    expect(isSafeStorageKey(`${ID.toUpperCase()}.pdf`)).toBe(false);
    expect(isSafeStorageKey(`${ID}.pdf.txt`)).toBe(false);
    expect(isSafeStorageKey(`${ID}`)).toBe(false);
    expect(isSafeStorageKey(`${ID}.`)).toBe(false);
  });

  it("rejects anything containing a path separator or traversal", () => {
    expect(isSafeStorageKey(`../${ID}.pdf`)).toBe(false);
    expect(isSafeStorageKey(`..\\${ID}.pdf`)).toBe(false);
    expect(isSafeStorageKey(`sub/${ID}.pdf`)).toBe(false);
    expect(isSafeStorageKey(`/etc/passwd/${ID}.pdf`)).toBe(false);
  });

  it("rejects a key with an embedded newline", () => {
    expect(isSafeStorageKey(`${ID}.pdf\n`)).toBe(false);
  });
});

describe("createLocalResumeStorage", () => {
  it("stores and returns the exact bytes", async () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]);

    await storage.save(PDF_KEY, data);

    const read = await storage.read(PDF_KEY);
    expect(read).toEqual(data);
  });

  it("round-trips an empty file without turning it into a missing one", async () => {
    await storage.save(PDF_KEY, new Uint8Array(0));

    await expect(storage.read(PDF_KEY)).resolves.toEqual(new Uint8Array(0));
  });

  it("creates the storage directory on first save", async () => {
    await storage.save(PDF_KEY, new Uint8Array([1]));

    await expect(readdir(root)).resolves.toEqual([PDF_KEY]);
  });

  it("returns null when nothing is stored under the key", async () => {
    await expect(storage.read(PDF_KEY)).resolves.toBeNull();
  });

  it("refuses to overwrite an existing file", async () => {
    const first = new Uint8Array([1, 2, 3]);
    await storage.save(PDF_KEY, first);

    await expect(storage.save(PDF_KEY, new Uint8Array([9, 9, 9]))).rejects.toBeInstanceOf(
      ResumeStorageError,
    );

    // The original bytes must survive the failed write.
    await expect(storage.read(PDF_KEY)).resolves.toEqual(first);
  });

  it("deletes a stored file", async () => {
    await storage.save(PDF_KEY, new Uint8Array([1]));

    await storage.delete(PDF_KEY);

    await expect(storage.read(PDF_KEY)).resolves.toBeNull();
  });

  it("treats delete as idempotent so rollback can retry safely", async () => {
    await storage.delete(PDF_KEY);

    await expect(storage.delete(PDF_KEY)).resolves.toBeUndefined();
  });

  describe("key validation", () => {
    it("refuses to read through a traversal key", async () => {
      await writeFile(path.join(root, "secret.txt"), "private", "utf8");

      await expect(storage.read("../secret.txt")).rejects.toBeInstanceOf(ResumeStorageError);
    });

    it("refuses to save through a traversal key", async () => {
      await expect(storage.save("../escape.pdf", new Uint8Array([1]))).rejects.toBeInstanceOf(
        ResumeStorageError,
      );
    });

    it("refuses to delete through a traversal key", async () => {
      await expect(storage.delete("../escape.pdf")).rejects.toBeInstanceOf(ResumeStorageError);
    });

    it("rejects an absolute path key", async () => {
      await expect(storage.read("/etc/passwd")).rejects.toBeInstanceOf(ResumeStorageError);
    });
  });

  describe("error mapping", () => {
    it("does not leak the absolute path in a save failure", async () => {
      // A directory at the key path makes writeFile fail with EISDIR.
      await storage.save(PDF_KEY, new Uint8Array([1]));
      const blocking = createLocalResumeStorage(root);

      await blocking.save(PDF_KEY, new Uint8Array([2])).catch((error: unknown) => {
        expect(error).toBeInstanceOf(ResumeStorageError);
        expect((error as Error).message).not.toContain(root);
        expect((error as Error).message).not.toContain(tmpdir());
      });
    });

    it("keeps the underlying error as the cause for the server log", async () => {
      await storage.save(PDF_KEY, new Uint8Array([1]));

      const error = await storage.save(PDF_KEY, new Uint8Array([2])).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ResumeStorageError);
      expect((error as Error).cause).toBeDefined();
      expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("EEXIST");
    });
  });
});

describe("DEFAULT_RESUME_STORAGE_DIR", () => {
  it("lives outside src and public so uploads are never bundled or served", () => {
    expect(DEFAULT_RESUME_STORAGE_DIR).toBe(path.join(process.cwd(), ".data", "resumes"));
    expect(DEFAULT_RESUME_STORAGE_DIR).not.toContain(`${path.sep}src${path.sep}`);
    expect(DEFAULT_RESUME_STORAGE_DIR).not.toContain(`${path.sep}public${path.sep}`);
  });
});