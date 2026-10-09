/**
 * Error layer for the resume parsing domain.
 *
 * The parser, extractors, and normalizer throw these instead of leaking
 * library-specific errors, and each carries the HTTP status the API should use.
 * Messages are written for the caller and never contain file contents,
 * absolute paths, driver output, or stack traces.
 */

/** Stable, machine-readable reasons parsing can fail. */
export type ResumeParseErrorCode =
  | "no_resume_file"
  | "resume_text_extraction_failed"
  | "resume_parse_failed"
  | "resume_validation_failed"
  | "storage_unavailable"
  | "storage_failure"
  | "profile_update_failed";

const STATUS_BY_CODE: Record<ResumeParseErrorCode, number> = {
  no_resume_file: 404,
  resume_text_extraction_failed: 422,
  resume_parse_failed: 422,
  resume_validation_failed: 422,
  storage_unavailable: 503,
  storage_failure: 500,
  profile_update_failed: 500,
};

export class ResumeParseError extends Error {
  readonly code: ResumeParseErrorCode;
  readonly status: number;

  constructor(code: ResumeParseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResumeParseError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

/** No resume file exists for the user. */
export class ResumeNotFoundError extends ResumeParseError {
  constructor(message = "No resume file exists for this user.") {
    super("no_resume_file", message);
    this.name = "ResumeNotFoundError";
  }
}

/** The document could be opened but contained no usable text. */
export class ResumeTextExtractionFailedError extends ResumeParseError {
  constructor(message = "The resume file could not be read as text.", options?: { cause?: unknown }) {
    super("resume_text_extraction_failed", message, options);
    this.name = "ResumeTextExtractionFailedError";
  }
}

/** The extracted text could not be parsed into a structured profile. */
export class ResumeParseFailedError extends ResumeParseError {
  constructor(message = "The resume could not be parsed.", options?: { cause?: unknown }) {
    super("resume_parse_failed", message, options);
    this.name = "ResumeParseFailedError";
  }
}

/** The parsed profile failed schema validation. */
export class ResumeValidationFailedError extends ResumeParseError {
  constructor(message = "The parsed resume does not match the expected structure.", options?: { cause?: unknown }) {
    super("resume_validation_failed", message, options);
    this.name = "ResumeValidationFailedError";
  }
}

/** The storage location could not be reached at all. */
export class ResumeStorageUnavailableError extends ResumeParseError {
  constructor(message = "The resume storage is unavailable.", options?: { cause?: unknown }) {
    super("storage_unavailable", message, options);
    this.name = "ResumeStorageUnavailableError";
  }
}

/** The storage location was reachable but the individual operation failed. */
export class ResumeStorageError extends ResumeParseError {
  constructor(message = "The resume file could not be read.", options?: { cause?: unknown }) {
    super("storage_failure", message, options);
    this.name = "ResumeStorageError";
  }
}

/**
 * The profile could not be updated with the parsed resume.
 *
 * There is deliberately no "profile not found" variant here: parsing creates the
 * profile when it is missing, so a missing profile is a normal outcome rather
 * than a failure.
 */
export class ProfileUpdateFailedError extends ResumeParseError {
  constructor(message = "The profile could not be updated.", options?: { cause?: unknown }) {
    super("profile_update_failed", message, options);
    this.name = "ProfileUpdateFailedError";
  }
}

export function isResumeParseError(error: unknown): error is ResumeParseError {
  return error instanceof ResumeParseError;
}