import {
  ProfileError,
  ProfileValidationError,
  type ProfileErrorCode,
} from "@/lib/profile/errors";
import type { ValidationIssue } from "@/lib/profile/types";

/**
 * Maps profile domain errors onto HTTP responses.
 *
 * Every response shares one body shape so a client can branch on
 * `error.code` instead of parsing messages:
 *
 *   { "error": { "code": "...", "message": "...", "issues"?: [...] } }
 *
 * `issues` is only included for request-side validation problems, where the
 * caller can actually act on it. Server-side problems such as corrupted stored
 * data report the code alone: the underlying field paths describe our schema,
 * not the caller's mistake.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

export type ProfileErrorBody = {
  error: {
    code: ProfileErrorCode | "internal_error";
    message: string;
    issues?: ValidationIssue[];
  };
};

export function profileErrorResponse(error: unknown): Response {
  if (error instanceof ProfileValidationError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          issues: [...error.issues],
        },
      },
      400,
    );
  }

  if (error instanceof ProfileError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }

  return json(
    { error: { code: "internal_error", message: "Something went wrong handling the request." } },
    500,
  );
}

function json(body: ProfileErrorBody, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Logs an error server-side with its cause, then returns the safe response.
 *
 * Expected domain failures are logged as `warn`: they are part of normal
 * operation (a profile that does not exist yet, an invalid payload). Anything
 * else is logged as `error` with the full cause chain for diagnosis.
 */
export function respondWithProfileError(error: unknown): Response {
  if (error instanceof ProfileError) {
    console.warn(`[profile] ${error.code}: ${error.message}`, { cause: error.cause });
  } else {
    console.error("[profile] unhandled failure", error);
  }

  return profileErrorResponse(error);
}