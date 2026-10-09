import { describe, expect, it } from "vitest";

import {
  checkResumeSelection,
  formatFileSize,
  resolveResumeExtension,
  type SelectedFileLike,
} from "@/lib/resume/selection";
import {
  MAX_RESUME_SIZE_BYTES,
  PDF_MIME_TYPE,
  RESUME_EXTENSIONS,
  DOCX_MIME_TYPE,
} from "@/lib/resume/types";

/**
 * Tests for the client-side pre-upload checks.
 *
 * `SelectedFileLike` is a plain shape, so these cases pass literal objects
 * rather than real `File` instances — that is deliberate: the browser passes a
 * `File`, but nothing here depends on binary content, and a literal keeps the
 * size cases readable.
 */

const PDF_FILE: SelectedFileLike = {
  name: "Ada Lovelace - Resume.pdf",
  size: 2048,
  type: PDF_MIME_TYPE,
};

const DOCX_FILE: SelectedFileLike = {
  name: "Ada Lovelace - Resume.docx",
  size: 2048,
  type: DOCX_MIME_TYPE,
};

describe("resolveResumeExtension", () => {
  it("resolves a PDF whose extension and MIME type agree", () => {
    expect(resolveResumeExtension(PDF_FILE)).toBe("pdf");
  });

  it("resolves a DOCX whose extension and MIME type agree", () => {
    expect(resolveResumeExtension(DOCX_FILE)).toBe("docx");
  });

  it("is case-insensitive on the declared MIME type", () => {
    expect(resolveResumeExtension({ ...PDF_FILE, type: "Application/PDF" })).toBe("pdf");
  });

  it("is case-insensitive on the extension", () => {
    expect(resolveResumeExtension({ ...PDF_FILE, name: "Resume.PDF" })).toBe("pdf");
    expect(resolveResumeExtension({ ...DOCX_FILE, name: "Resume.DOCX" })).toBe("docx");
  });

  it("refuses when the extension and the MIME type disagree", () => {
    expect(resolveResumeExtension({ ...PDF_FILE, type: DOCX_MIME_TYPE })).toBeNull();
    expect(resolveResumeExtension({ ...DOCX_FILE, type: PDF_MIME_TYPE })).toBeNull();
  });

  it("refuses a blank MIME type instead of treating it as a free pass", () => {
    expect(resolveResumeExtension({ ...PDF_FILE, type: "" })).toBeNull();
  });

  it("refuses unsupported extensions", () => {
    for (const extension of RESUME_EXTENSIONS) {
      const file: SelectedFileLike = { name: `resume.${extension}`, size: 10, type: "text/plain" };
      expect(resolveResumeExtension(file)).toBeNull();
    }

    expect(resolveResumeExtension({ name: "resume.exe", size: 10, type: "application/octet-stream" })).toBeNull();
    expect(resolveResumeExtension({ name: "resume.txt", size: 10, type: "text/plain" })).toBeNull();
    expect(resolveResumeExtension({ name: "resume.doc", size: 10, type: "application/msword" })).toBeNull();
  });

  it("refuses a name with no extension", () => {
    expect(resolveResumeExtension({ name: "resume", size: 10, type: PDF_MIME_TYPE })).toBeNull();
  });

  it("refuses a trailing dot, which is not an extension", () => {
    expect(resolveResumeExtension({ name: "resume.", size: 10, type: PDF_MIME_TYPE })).toBeNull();
  });

  it("reads the extension from the final dot in the final path segment", () => {
    expect(resolveResumeExtension({ name: "my.resume.v2.pdf", size: 10, type: PDF_MIME_TYPE })).toBe("pdf");
    // A directory segment with a dot must not supply the extension.
    expect(resolveResumeExtension({ name: "folder.pdf/resume", size: 10, type: PDF_MIME_TYPE })).toBeNull();
    expect(resolveResumeExtension({ name: "folder.pdf/resume.pdf", size: 10, type: PDF_MIME_TYPE })).toBe("pdf");
  });

  it("ignores a leading dot, which marks a hidden file rather than an extension", () => {
    expect(resolveResumeExtension({ name: ".pdf", size: 10, type: PDF_MIME_TYPE })).toBeNull();
  });
});

describe("formatFileSize", () => {
  it("reports small files in bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1)).toBe("1 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("reports kilobytes below 10 with one decimal", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(9216)).toBe("9.0 KB");
  });

  it("drops the decimal above 10 to stay short", () => {
    expect(formatFileSize(10 * 1024)).toBe("10 KB");
    expect(formatFileSize(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("scales through megabytes and gigabytes", () => {
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    // 10 and above drop the decimal, so this reads "10 MB" like "10 KB" above.
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatFileSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

describe("checkResumeSelection", () => {
  it("accepts an acceptable PDF and reports its extension", () => {
    expect(checkResumeSelection(PDF_FILE)).toEqual({ ok: true, extension: "pdf" });
  });

  it("accepts an acceptable DOCX and reports its extension", () => {
    expect(checkResumeSelection(DOCX_FILE)).toEqual({ ok: true, extension: "docx" });
  });

  it("refuses an empty file before looking at its format", () => {
    const result = checkResumeSelection({ ...PDF_FILE, size: 0 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/empty/i);
  });

  it("refuses an oversized file on its size alone", () => {
    const result = checkResumeSelection({
      ...PDF_FILE,
      size: MAX_RESUME_SIZE_BYTES + 1,
    });

    expect(result.ok).toBe(false);
    // The message must name the limit so the user knows what happened.
    expect(result.ok === false && result.message).toContain(formatFileSize(MAX_RESUME_SIZE_BYTES));
  });

  it("accepts a file exactly at the limit", () => {
    expect(checkResumeSelection({ ...PDF_FILE, size: MAX_RESUME_SIZE_BYTES })).toEqual({
      ok: true,
      extension: "pdf",
    });
  });

  it("refuses an unsupported format", () => {
    const result = checkResumeSelection({ name: "resume.txt", size: 10, type: "text/plain" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("PDF");
    expect(result.ok === false && result.message).toContain("DOCX");
  });

  it("refuses a disguised extension", () => {
    expect(checkResumeSelection({ ...PDF_FILE, name: "resume.docx" }).ok).toBe(false);
  });

  it("checks size before format so a huge wrong-type file is reported as oversized", () => {
    const result = checkResumeSelection({
      name: "resume.txt",
      size: MAX_RESUME_SIZE_BYTES + 1,
      type: "text/plain",
    });

    expect(result.ok === false && result.message).toMatch(/limit/i);
    expect(result.ok === false && result.message).not.toMatch(/only/i);
  });
});