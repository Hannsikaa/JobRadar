import { describe, expect, it, vi } from "vitest";

import {
  ResumeFileTooLargeError,
  ResumeInvalidFileError,
  ResumeUnsupportedFileTypeError,
} from "@/lib/resume/errors";
import { validateResumeFile } from "@/lib/resume/validation";
import {
  DOCX_MIME_TYPE,
  MAX_RESUME_SIZE_BYTES,
  PDF_MIME_TYPE,
} from "@/lib/resume/types";

/**
 * Tests for server-side upload validation.
 *
 * Real `File` objects are used rather than stand-ins: the interesting behaviour
 * lives in `slice().arrayBuffer()` byte sniffing, so the cases have to carry real
 * signatures. Only the size tests fake `size`, because a 10 MB fixture would
 * slow the suite for no extra coverage.
 */

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const DOCX_BYTES = new TextEncoder().encode(
  "PK\u0003\u0004[Content_Types].xmlword/document.xmlword/_rels/document.xml.rels",
);

function pdfFile(name = "resume.pdf", bytes: Uint8Array<ArrayBuffer> = PDF_BYTES): File {
  return new File([bytes], name, { type: PDF_MIME_TYPE });
}

function docxFile(name = "resume.docx", bytes: Uint8Array<ArrayBuffer> = DOCX_BYTES): File {
  return new File([bytes], name, { type: DOCX_MIME_TYPE });
}

/** A file whose reported size is fake, so size checks do not allocate bytes. */
function sizedFile(name: string, type: string, size: number): File {
  const file = new File([PDF_BYTES], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("validateResumeFile", () => {
  it("returns metadata for a real PDF", async () => {
    await expect(validateResumeFile(pdfFile("Ada Lovelace - Resume.pdf"))).resolves.toEqual({
      originalFilename: "Ada Lovelace - Resume.pdf",
      mimeType: PDF_MIME_TYPE,
      extension: "pdf",
      sizeBytes: PDF_BYTES.byteLength,
    });
  });

  it("returns metadata for a real DOCX", async () => {
    await expect(validateResumeFile(docxFile())).resolves.toEqual({
      originalFilename: "resume.docx",
      mimeType: DOCX_MIME_TYPE,
      extension: "docx",
      sizeBytes: DOCX_BYTES.byteLength,
    });
  });

  it("accepts a DOCX whose binary content has non-printable tail bytes", async () => {
    // Only the ZIP header and the OOXML part names are inspected, so trailing
    // bytes are irrelevant to the check; the mime sniff is limited to a prefix.
    const binaryTail = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x00, 0x7f]);
    const withTail = new Uint8Array([...DOCX_BYTES, ...binaryTail]);

    await expect(validateResumeFile(docxFile("resume.docx", withTail))).resolves.toMatchObject({
      extension: "docx",
    });
  });

  it("lowercases the stored MIME type", async () => {
    const mixedCase = new File([PDF_BYTES], "resume.pdf", { type: "Application/PDF" });

    await expect(validateResumeFile(mixedCase)).resolves.toMatchObject({
      mimeType: "application/pdf",
    });
  });

  it("rejects an oversized file before reading any bytes", async () => {
    const file = sizedFile("resume.pdf", PDF_MIME_TYPE, MAX_RESUME_SIZE_BYTES + 1);
    const slice = vi.spyOn(file, "slice");

    await expect(validateResumeFile(file)).rejects.toBeInstanceOf(ResumeFileTooLargeError);
    expect(slice).not.toHaveBeenCalled();
  });

  it("reports the oversized status as 413", async () => {
    const file = sizedFile("resume.pdf", PDF_MIME_TYPE, MAX_RESUME_SIZE_BYTES + 1);

    await expect(validateResumeFile(file)).rejects.toMatchObject({
      code: "file_too_large",
      status: 413,
    });
  });

  it("accepts a file exactly at the limit", async () => {
    const file = sizedFile("resume.pdf", PDF_MIME_TYPE, MAX_RESUME_SIZE_BYTES);

    await expect(validateResumeFile(file)).resolves.toMatchObject({ extension: "pdf" });
  });

  it("rejects an empty file as invalid", async () => {
    const empty = new File([], "resume.pdf", { type: PDF_MIME_TYPE });

    await expect(validateResumeFile(empty)).rejects.toBeInstanceOf(ResumeInvalidFileError);
    await expect(validateResumeFile(empty)).rejects.toMatchObject({
      code: "invalid_file",
      status: 400,
    });
  });

  it("strips a submitted directory path from the filename", async () => {
    await expect(validateResumeFile(pdfFile("C:\\Users\\me\\resume.pdf"))).resolves.toMatchObject({
      originalFilename: "resume.pdf",
    });
    await expect(validateResumeFile(pdfFile("/tmp/nested/resume.pdf"))).resolves.toMatchObject({
      originalFilename: "resume.pdf",
    });
  });

  it("drops control characters from the filename", async () => {
    const name = "re\u0000s\u001fum\u0007e.pdf";

    await expect(validateResumeFile(pdfFile(name))).resolves.toMatchObject({
      originalFilename: "resume.pdf",
    });
  });

  it("rejects a filename that sanitizes to nothing", async () => {
    await expect(validateResumeFile(pdfFile("\u0000\u0000"))).rejects.toBeInstanceOf(
      ResumeInvalidFileError,
    );
    await expect(validateResumeFile(pdfFile("\u0000\u0000"))).rejects.toMatchObject({
      code: "invalid_file",
      status: 400,
    });
  });

  it("truncates an over-long filename to 200 characters", async () => {
    const longName = `${"a".repeat(400)}.pdf`;
    const result = await validateResumeFile(pdfFile(longName));

    expect(result.originalFilename).toHaveLength(200);
  });

  it("rejects unsupported extensions and MIME types", async () => {
    const text = new File([PDF_BYTES], "resume.txt", { type: "text/plain" });
    const executable = new File([PDF_BYTES], "resume.exe", { type: "application/octet-stream" });

    await expect(validateResumeFile(text)).rejects.toBeInstanceOf(ResumeUnsupportedFileTypeError);
    await expect(validateResumeFile(executable)).rejects.toMatchObject({
      code: "unsupported_file_type",
      status: 415,
    });
  });

  it("rejects a PDF extension sent with the DOCX MIME type", async () => {
    const mismatched = new File([PDF_BYTES], "resume.pdf", { type: DOCX_MIME_TYPE });

    await expect(validateResumeFile(mismatched)).rejects.toMatchObject({
      code: "unsupported_file_type",
      status: 415,
    });
  });

  it("rejects a renamed executable that starts with the PDF header", async () => {
    // A PDF header is only bytes; the format check cannot and should not
    // attempt to parse the document, but it does reject obvious spoofs.
    const spoof = new File([new TextEncoder().encode("<html>not a pdf")], "resume.pdf", {
      type: PDF_MIME_TYPE,
    });

    await expect(validateResumeFile(spoof)).rejects.toBeInstanceOf(ResumeInvalidFileError);
    await expect(validateResumeFile(spoof)).rejects.toMatchObject({
      code: "invalid_file",
      status: 400,
    });
  });

  it("rejects a DOCX named .pdf and a PDF named .docx", async () => {
    const docxNamedPdf = new File([DOCX_BYTES], "resume.pdf", { type: PDF_MIME_TYPE });
    const pdfNamedDocx = new File([PDF_BYTES], "resume.docx", { type: DOCX_MIME_TYPE });

    await expect(validateResumeFile(docxNamedPdf)).rejects.toMatchObject({ code: "invalid_file" });
    await expect(validateResumeFile(pdfNamedDocx)).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("rejects a DOCX whose ZIP container is missing", async () => {
    const notZip = new File(
      [new TextEncoder().encode("[Content_Types].xmlword/document.xml")],
      "resume.docx",
      { type: DOCX_MIME_TYPE },
    );

    await expect(validateResumeFile(notZip)).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("rejects a DOCX whose OOXML parts are missing", async () => {
    const emptyZip = new File([new TextEncoder().encode("PK\u0003\u0004nothing useful")], "resume.docx", {
      type: DOCX_MIME_TYPE,
    });

    await expect(validateResumeFile(emptyZip)).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("never leaks file contents or internal error details in messages", async () => {
    const secretMarker = "TOP-SECRET-RESUME-CONTENT";

    try {
      await validateResumeFile(new File([secretMarker], "resume.pdf", { type: PDF_MIME_TYPE }));
      expect.unreachable("expected validation to reject the file");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretMarker);
    }
  });

  it("reports the supported-format failures as 400 or 415, never 500", async () => {
    const failures = [
      new File([], "resume.pdf", { type: PDF_MIME_TYPE }),
      new File([PDF_BYTES], "resume.txt", { type: "text/plain" }),
      new File([new TextEncoder().encode("<html>")], "resume.pdf", { type: PDF_MIME_TYPE }),
    ];

    for (const file of failures) {
      const error = await validateResumeFile(file).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect((error as { status: number }).status).toBeLessThan(500);
    }
  });
});