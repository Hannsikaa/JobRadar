import { ResumeError, type ResumeErrorCode } from "@/lib/resume/errors";

/**
 * Maps resume domain errors onto HTTP responses.
 *
 * Shares the profile route's envelope so clients can branch on `error.code`
 * rather than parsing messages:
 *
 *   { "error": { "code": "...", "message": "..." } }
 *
 * Every response is `no-store`: an upload result must never be cached, and an
 * error message says nothing that belongs in a cache.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

export type ResumeErrorBody = {
  error: {
    code: ResumeErrorCode | "internal_error";
    message: string;
  };
};

function json(body: ResumeErrorBody, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function resumeErrorResponse(error: unknown): Response {
  if (error instanceof ResumeError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }

  return json(
    { error: { code: "internal_error", message: "Something went wrong handling the request." } },
    500,
  );
}

/**
 * Logs an error server-side with its cause, then returns the safe response.
 *
 * A rejected file is logged as `warn` because rejecting bad input is the
 * endpoint working as intended; anything unrecognized is a real failure and is
 * logged in full. Neither branch puts file contents or storage paths in the
 * response.
 */
export function respondWithResumeError(error: unknown): Response {
  if (error instanceof ResumeError) {
    console.warn(`[resume] ${error.code}: ${error.message}`, { cause: error.cause });
  } else {
    console.error("[resume] unhandled failure", error);
  }

  return resumeErrorResponse(error);
}