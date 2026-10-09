import { respondWithResumeParseError } from "@/app/api/resume/parse/error-response";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import { ResumeRequestError } from "@/lib/resume/errors";
import { parseResumeForUser } from "@/lib/resume/parser";

/**
 * POST /api/resume/parse — parse a stored resume into a structured profile.
 *
 * The request body must be JSON with a `resumeFileId` field identifying the
 * previously uploaded resume to parse. The file is read from storage, text is
 * extracted, parsed into a ResumeProfile, validated, and persisted to the
 * user's profile.
 *
 * A profile does not have to exist beforehand: this is the step that creates it.
 * Parsing therefore preserves any preferences already stored, and never
 * overwrites them with something it guessed. The saved profile records which
 * resume it was derived from, so a later replacement can be detected.
 *
 * Identity comes from the shared demo-identity header, because authentication is
 * not implemented yet. See `@/lib/identity/user-id`.
 *
 * The response contains the parsed profile; the storage key, the path on
 * disk, and the file contents never leave the server.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(request: Request): Promise<Response> {
  try {
    const userId = readUserId(request);
    const { resumeFileId } = await readParseBody(request);

    const result = await parseResumeForUser(userId, resumeFileId);

    return Response.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    return respondWithResumeParseError(error);
  }
}

/**
 * Resolves the caller, translating the identity shim's error into this
 * endpoint's own request error.
 *
 * The shim's own message is deliberately dropped rather than forwarded: it
 * names the internal header we read identity from, and it can also carry a
 * database error whose text contains a connection string. The caller gets a
 * fixed sentence, and the original error stays on `cause` for the server log.
 */
function readUserId(request: Request): string {
  try {
    return resolveUserId(request);
  } catch (error) {
    throw new ResumeRequestError("The request could not be attributed to a user.", { cause: error });
  }
}

/**
 * Parses the request body as a parse request.
 *
 * A malformed JSON body is reported as a request error rather than a
 * validation error: the caller sent something that is not JSON at all, so
 * there are no field paths to report.
 */
async function readParseBody(request: Request): Promise<{ resumeFileId: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ResumeRequestError("Request body must be valid JSON.");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ResumeRequestError("Request body must be a JSON object.");
  }

  const { resumeFileId } = body as { resumeFileId?: unknown };

  if (typeof resumeFileId !== "string" || resumeFileId.trim().length === 0) {
    throw new ResumeRequestError("Request body must include a non-empty 'resumeFileId' string.");
  }

  return { resumeFileId: resumeFileId.trim() };
}