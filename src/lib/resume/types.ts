/**
 * Shared types and constants for the resume upload domain.
 *
 * This module is deliberately dependency-free so that both the server-side
 * validation layer and the client-side upload component can import it. Anything
 * that touches the filesystem or MongoDB belongs in a different file.
 */

/** The multipart form field the client must post the file under. */
export const RESUME_FILE_FIELD = "resume";

/**
 * Maximum accepted upload size, in bytes.
 *
 * Note that this is checked *after* the runtime has buffered the multipart
 * part, because `request.formData()` is the only supported way to read the
 * body. It therefore bounds how much we read into memory and persist, rather
 * than the amount the server is willing to receive off the wire.
 */
export const MAX_RESUME_SIZE_BYTES = 10 * 1024 * 1024;

/** File formats the app accepts, each with the one MIME type it must be sent as. */
export const RESUME_MIME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

/**
 * The MIME types by name, for the few call sites that handle one format at a
 * time. Derived rather than repeated so the literal appears exactly once.
 */
export const PDF_MIME_TYPE = RESUME_MIME_TYPES.pdf;
export const DOCX_MIME_TYPE = RESUME_MIME_TYPES.docx;

/** The accepted file extensions, in the order they are reported to callers. */
export const RESUME_EXTENSIONS = ["pdf", "docx"] as const;

/** One of the accepted resume file extensions. */
export type ResumeFileExtension = (typeof RESUME_EXTENSIONS)[number];

/** Metadata for a stored resume, safe to return from the API. */
export type ResumeFileMetadata = {
  /** Public identifier, also used as the storage object name. */
  id: string;
  /** Filename as submitted, stripped of any directory component. */
  originalFilename: string;
  /** The verified MIME type of the stored bytes. */
  mimeType: string;
  extension: ResumeFileExtension;
  sizeBytes: number;
  /** ISO 8601 timestamp of when the upload completed. */
  uploadedAt: string;
};

/**
 * A stored resume as the repository sees it.
 *
 * `storageKey` is deliberately absent from `ResumeFileMetadata`: the API must
 * never tell a caller where files live on disk, so the key stays internal to
 * the server and the response is projected down to the public fields.
 */
export type StoredResumeFile = ResumeFileMetadata & {
  userId: string;
  storageKey: string;
};

/**
 * Projects a stored resume down to the public metadata the API may return.
 *
 * Built field by field rather than by omitting keys, so `storageKey` and
 * `userId` cannot leak into a response even if the stored shape grows. Every
 * response path — a fresh upload, a replacement, a later read — goes through
 * this one function so none of them can drift.
 */
export function toResumeFileMetadata(stored: StoredResumeFile): ResumeFileMetadata {
  return {
    id: stored.id,
    originalFilename: stored.originalFilename,
    mimeType: stored.mimeType,
    extension: stored.extension,
    sizeBytes: stored.sizeBytes,
    uploadedAt: stored.uploadedAt,
  };
}

/** A file that passed server-side validation, reduced to what we persist. */
export type ValidatedResumeFile = {
  originalFilename: string;
  mimeType: string;
  extension: ResumeFileExtension;
  sizeBytes: number;
};