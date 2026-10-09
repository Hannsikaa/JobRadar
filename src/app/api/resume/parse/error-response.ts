import { ResumeParseError, type ResumeParseErrorCode } from "@/lib/resume/parser/errors";
import { ResumeRequestError, ResumeError, type ResumeErrorCode } from "@/lib/resume/errors";

/**
 * Maps resume parse domain errors onto HTTP responses.
 *
 * Shares the same envelope as other resume endpoints so clients can branch on
 * `error.code` rather than parsing messages:
 *
 *   { "error": { "code": "...", "message": "..." } }
 *
 * Every response is `no-store`: a parse result must never be cached, and an
 * error message says nothing that belongs in a cache.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

export type ResumeParseErrorBody = {
  error: {
    code: ResumeParseErrorCode | ResumeErrorCode | "internal_error";
    message: string;
  };
};

function json(body: ResumeParseErrorBody, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function resumeParseErrorResponse(error: unknown): Response {
  if (error instanceof ResumeParseError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }

  if (error instanceof ResumeRequestError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }

  if (error instanceof ResumeError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }

  return json(
    { error: { code: "internal_error", message: "Something went wrong parsing the resume." } },
    500,
  );
}

/**
 * Logs an error server-side with its cause, then returns the safe response.
 *
 * Expected domain failures are logged as `warn`: they are part of normal
 * operation (a resume that does not exist, extraction failure). Anything
 * else is logged as `error` with the full cause chain for diagnosis.
 */
export function respondWithResumeParseError(error: unknown): Response {
  if (error instanceof ResumeParseError || error instanceof ResumeRequestError || error instanceof ResumeError) {
    console.warn(`[resume/parse] ${error.code}: ${error.message}`, { cause: error.cause });
  } else {
    console.error("[resume/parse] unhandled failure", error);
  }

  return resumeParseErrorResponse(error);
}