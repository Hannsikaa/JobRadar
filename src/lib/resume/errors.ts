/**
 * Error layer for the resume upload domain.
 *
 * The service, storage adapter, and repository throw these instead of leaking
 * MongoDB, filesystem, or `formData()` errors, and each carries the HTTP status
 * the API should use. Messages are written for the caller and never contain
 * file contents, absolute paths, driver output, or stack traces.
 */

import { RESUME_FILE_FIELD } from "@/lib/resume/types";

/** Stable, machine-readable reasons an upload can fail. */
export type ResumeErrorCode =
  | "invalid_request"
  | "missing_file"
  | "invalid_file"
  | "file_too_large"
  | "unsupported_file_type"
  | "not_found"
  | "upload_failed"
  | "storage_unavailable"
  | "storage_failure";

const STATUS_BY_CODE: Record<ResumeErrorCode, number> = {
  invalid_request: 400,
  missing_file: 400,
  invalid_file: 400,
  file_too_large: 413,
  unsupported_file_type: 415,
  not_found: 404,
  upload_failed: 500,
  storage_unavailable: 503,
  storage_failure: 500,
};

export class ResumeError extends Error {
  readonly code: ResumeErrorCode;
  readonly status: number;

  constructor(code: ResumeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResumeError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

/** The request body could not be read as multipart form data at all. */
export class ResumeRequestError extends ResumeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("invalid_request", message, options);
    this.name = "ResumeRequestError";
  }
}

/** The multipart body parsed, but the `resume` part was absent or not a file. */
export class ResumeMissingFileError extends ResumeError {
  constructor(
    message = `No file was submitted under the "${RESUME_FILE_FIELD}" field.`,
  ) {
    super("missing_file", message);
    this.name = "ResumeMissingFileError";
  }
}

/** The file is the wrong shape to accept: bad name, empty, or wrong contents. */
export class ResumeInvalidFileError extends ResumeError {
  constructor(message: string) {
    super("invalid_file", message);
    this.name = "ResumeInvalidFileError";
  }
}

/** The file is larger than the 10 MB limit. */
export class ResumeFileTooLargeError extends ResumeError {
  constructor(message = "The uploaded file is larger than the 10 MB limit.") {
    super("file_too_large", message);
    this.name = "ResumeFileTooLargeError";
  }
}

/** The file is not one of the accepted formats, or claims the wrong MIME type. */
export class ResumeUnsupportedFileTypeError extends ResumeError {
  constructor(message = "Only PDF and DOCX files are accepted.") {
    super("unsupported_file_type", message);
    this.name = "ResumeUnsupportedFileTypeError";
  }
}

/** No stored resume exists for the given identifier. */
export class ResumeNotFoundError extends ResumeError {
  constructor(message = "No resume file exists for this identifier.") {
    super("not_found", message);
    this.name = "ResumeNotFoundError";
  }
}

/** The file was accepted but could not be persisted; nothing was kept. */
export class ResumeUploadError extends ResumeError {
  constructor(message = "The resume could not be saved.", options?: { cause?: unknown }) {
    super("upload_failed", message, options);
    this.name = "ResumeUploadError";
  }
}

/** The storage location could not be reached at all. */
export class ResumeStorageUnavailableError extends ResumeError {
  constructor(message = "The resume storage is unavailable.", options?: { cause?: unknown }) {
    super("storage_unavailable", message, options);
    this.name = "ResumeStorageUnavailableError";
  }
}

/** The storage location was reachable but the individual operation failed. */
export class ResumeStorageError extends ResumeError {
  constructor(message = "The resume file could not be stored.", options?: { cause?: unknown }) {
    super("storage_failure", message, options);
    this.name = "ResumeStorageError";
  }
}

export function isResumeError(error: unknown): error is ResumeError {
  return error instanceof ResumeError;
}