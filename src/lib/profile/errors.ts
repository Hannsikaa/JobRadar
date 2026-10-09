import type { ValidationIssue } from "@/lib/profile/types";

/**
 * Error layer for the profile domain.
 *
 * The repository and the API route throw these instead of leaking MongoDB or
 * driver errors, and each error carries the HTTP status the API should use.
 * Messages are written for the caller: they never contain raw driver output,
 * connection strings, or document contents.
 */

/** Stable, machine-readable reasons a profile operation can fail. */
export type ProfileErrorCode =
  | "validation"
  | "invalid_request"
  | "not_found"
  | "already_exists"
  | "storage_unavailable"
  | "storage_failure"
  | "corrupt_data";

const STATUS_BY_CODE: Record<ProfileErrorCode, number> = {
  validation: 400,
  invalid_request: 400,
  not_found: 404,
  already_exists: 409,
  storage_unavailable: 503,
  storage_failure: 500,
  corrupt_data: 500,
};

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly status: number;

  constructor(code: ProfileErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProfileError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

/** The submitted profile did not satisfy the schema. */
export class ProfileValidationError extends ProfileError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      "validation",
      issues.length === 1
        ? issues[0].message
        : `Profile is invalid: ${issues.length} problems found`,
    );
    this.name = "ProfileValidationError";
    this.issues = issues;
  }
}

/**
 * The request could not be handled at all, e.g. a missing user id.
 *
 * `options.cause` is honoured so a caller can keep the underlying failure —
 * an identity shim error, say — for the server log without putting its text in
 * the response.
 */
export class ProfileRequestError extends ProfileError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("invalid_request", message, options);
    this.name = "ProfileRequestError";
  }
}

/** No profile exists for the given user yet. */
export class ProfileNotFoundError extends ProfileError {
  constructor() {
    super("not_found", "No profile exists for this user yet.");
    this.name = "ProfileNotFoundError";
  }
}

/** A profile already exists, so `createProfile` refused to add a second one. */
export class ProfileAlreadyExistsError extends ProfileError {
  constructor() {
    super("already_exists", "A profile already exists for this user.");
    this.name = "ProfileAlreadyExistsError";
  }
}

/** The database could not be reached at all. */
export class ProfileStoreUnavailableError extends ProfileError {
  constructor(message = "The profile database is unavailable.", options?: { cause?: unknown }) {
    super("storage_unavailable", message, options);
    this.name = "ProfileStoreUnavailableError";
  }
}

/** The database was reachable but the operation failed. */
export class ProfileStoreError extends ProfileError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("storage_failure", message, options);
    this.name = "ProfileStoreError";
  }
}

/** A stored document no longer matches the current schema. */
export class ProfileDataCorruptedError extends ProfileError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super("corrupt_data", "The stored profile does not match the current schema.");
    this.name = "ProfileDataCorruptedError";
    this.issues = issues;
  }
}

export function isProfileError(error: unknown): error is ProfileError {
  return error instanceof ProfileError;
}

/** MongoDB's duplicate-key error code, used to detect a repeated `userId`. */
const DUPLICATE_KEY_CODE = 11000;

/**
 * Detects a duplicate-key write failure without depending on the driver's
 * error classes, so the check also holds for wrapped or mocked errors.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (error as { code?: unknown }).code === DUPLICATE_KEY_CODE;
}