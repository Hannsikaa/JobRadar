/**
 * Server-side validation of an uploaded resume.
 *
 * Everything the browser claimed about the file is re-checked here, and the
 * file's *contents* are inspected as well: an upload is only accepted when its
 * first bytes look like the format it claims. That blocks a renamed executable
 * or an HTML page with a `.pdf` name, which would otherwise be stored and later
 * handed to a parser.
 *
 * Checks run cheapest-first. Size is enforced before any bytes are read so an
 * oversized upload is rejected without pulling it into memory.
 */

import {
  ResumeFileTooLargeError,
  ResumeInvalidFileError,
  ResumeUnsupportedFileTypeError,
} from "@/lib/resume/errors";
import { resolveResumeExtension } from "@/lib/resume/selection";
import {
  MAX_RESUME_SIZE_BYTES,
  type ValidatedResumeFile,
} from "@/lib/resume/types";

/** How much of the file we read when sniffing its format. */
const SNIFF_BYTES = 256 * 1024;

/** Every PDF begins with this five-byte header. */
const PDF_SIGNATURE = "%PDF-";

/** A DOCX is a ZIP archive, so its first four bytes are the local file header. */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/**
 * Entry points that mark a ZIP as a real OOXML document rather than any old
 * archive that happens to be named `.docx`.
 */
const OOXML_MARKERS = ["[Content_Types].xml", "word/document.xml"];

/** Longest filename we keep. Anything longer is truncated by the OS anyway. */
const MAX_FILENAME_LENGTH = 200;

/**
 * Reduces a submitted filename to a plain base name.
 *
 * Browsers may send a full path (`C:\Users\me\resume.pdf`) and untrusted
 * callers may send anything at all, so separators are stripped and control
 * characters are dropped. The value is used for display and metadata only:
 * stored files are named by generated UUID, so this can never influence a path
 * on disk.
 *
 * The length cap is applied separately, *after* the extension has been read.
 * Truncating here would cut the extension off a long name and report an
 * ordinary PDF as an unsupported type.
 */
function sanitizeFilename(rawName: string): string {
  const withoutPath = rawName.slice(Math.max(rawName.lastIndexOf("/"), rawName.lastIndexOf("\\")) + 1);

  return withoutPath.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/** Caps a sanitized name to what we keep in metadata and show to the user. */
function capFilename(name: string): string {
  return name.length > MAX_FILENAME_LENGTH ? name.slice(0, MAX_FILENAME_LENGTH) : name;
}

/** Reads the leading bytes of a file as latin1, which is a 1:1 byte mapping. */
async function readPrefix(file: File, length: number): Promise<string> {
  return new TextDecoder("latin1").decode(await file.slice(0, length).arrayBuffer());
}

function startsWithZipSignature(prefix: string): boolean {
  return ZIP_SIGNATURE.every((byte, index) => prefix.charCodeAt(index) === byte);
}

/**
 * Verifies that a DOCX is a ZIP container holding the expected OOXML parts.
 *
 * Only the first {@link SNIFF_BYTES} are searched: the parts we look for are at
 * the front of a Word-generated archive, and reading the whole file to confirm a
 * format would defeat the point of a cheap check.
 */
function looksLikeDocx(prefix: string): boolean {
  return startsWithZipSignature(prefix) && OOXML_MARKERS.every((marker) => prefix.includes(marker));
}

/** True when a PDF's leading bytes are the PDF header. */
function looksLikePdf(prefix: string): boolean {
  return prefix.startsWith(PDF_SIGNATURE);
}

/**
 * Validates an uploaded file, returning the metadata to persist.
 *
 * Throws `ResumeFileTooLargeError`, `ResumeInvalidFileError`, or
 * `ResumeUnsupportedFileTypeError`; all are safe to show to the caller.
 */
export async function validateResumeFile(file: File): Promise<ValidatedResumeFile> {
  if (file.size > MAX_RESUME_SIZE_BYTES) {
    throw new ResumeFileTooLargeError();
  }

  if (file.size <= 0) {
    throw new ResumeInvalidFileError("The uploaded file is empty.");
  }

  const sanitized = sanitizeFilename(file.name);
  if (sanitized.length === 0) {
    throw new ResumeInvalidFileError("The uploaded file has no usable filename.");
  }

  // The extension is read from the untruncated name: a 300-character name is
  // still a PDF, and only the stored copy of the name is capped.
  const extension = resolveResumeExtension({ name: sanitized, size: file.size, type: file.type });
  if (extension === null) {
    throw new ResumeUnsupportedFileTypeError();
  }

  const prefix = await readPrefix(file, SNIFF_BYTES);
  const contentsMatch = extension === "pdf" ? looksLikePdf(prefix) : looksLikeDocx(prefix);

  if (!contentsMatch) {
    throw new ResumeInvalidFileError(
      extension === "pdf"
        ? "That file is not a readable PDF."
        : "That file is not a readable DOCX document.",
    );
  }

  return {
    originalFilename: capFilename(sanitized),
    mimeType: file.type.toLowerCase(),
    extension,
    sizeBytes: file.size,
  };
}