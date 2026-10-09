import { respondWithProfileError } from "@/app/api/profile/error-response";
import {
  ProfileAlreadyExistsError,
  ProfileRequestError,
} from "@/lib/profile/errors";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import { UserIdentityError } from "@/lib/identity/user-id";
import {
  createProfile,
  getProfileByUserId,
  updateProfile,
} from "@/lib/profile/repository";
import type { JobProfileInput } from "@/lib/profile/types";

/**
 * GET /api/profile — read the caller's profile.
 * PUT /api/profile — create or replace the caller's profile.
 *
 * PUT is create-or-update at the API level: it creates, and if a profile
 * already exists it is replaced. `createdAt` is preserved across updates. The
 * response status distinguishes the two outcomes (201 on create, 200 on
 * update) so a client can tell them apart.
 *
 * A successful PUT also marks the profile as reviewed, because this endpoint is
 * only ever driven by a person editing their own Profile Review page. Later
 * chats compare that marker against the resume to decide whether stored profile
 * text still describes the current resume.
 *
 * Identity comes from a temporary header rather than a session, because
 * authentication is not implemented yet. See `@/lib/identity/user-id`.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const userId = readUserId(request);
    const profile = await getProfileByUserId(userId);

    if (profile === null) {
      return Response.json(
        { error: { code: "not_found", message: "No profile exists for this user yet." } },
        { status: 404, headers: NO_STORE },
      );
    }

    return Response.json(profile, { status: 200, headers: NO_STORE });
  } catch (error) {
    return respondWithProfileError(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const userId = readUserId(request);
    const input = await readProfileBody(request);

    try {
      const created = await createProfile(userId, input);
      return Response.json(created, { status: 201, headers: NO_STORE });
    } catch (error) {
      if (!(error instanceof ProfileAlreadyExistsError)) {
        throw error;
      }

      const updated = await updateProfile(userId, input);
      return Response.json(updated, { status: 200, headers: NO_STORE });
    }
  } catch (error) {
    return respondWithProfileError(error);
  }
}

/**
 * Resolves the caller, translating an identity failure into a profile request
 * error.
 *
 * The identity module has no opinion about HTTP or about which domain it is
 * serving, so it throws its own error type. Converting here keeps every response
 * on this route speaking the profile error envelope, and lets the route choose
 * the wording: the shared message says a user id was missing or unusable and
 * that this build has no sign-in, without naming an internal header or echoing
 * anything server-side.
 */
function readUserId(request: Request): string {
  try {
    return resolveUserId(request);
  } catch (error) {
    throw new ProfileRequestError(
      error instanceof UserIdentityError
        ? "The request could not be attributed to a user. Sign-in is not available yet; reload the page and try again."
        : "The request could not be attributed to a user.",
      { cause: error },
    );
  }
}

/**
 * Parses the request body as a profile.
 *
 * A malformed JSON body is reported as a request error rather than a
 * validation error: the caller sent something that is not JSON at all, so
 * there are no field paths to report.
 */
async function readProfileBody(request: Request): Promise<JobProfileInput> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ProfileRequestError("Request body must be valid JSON.");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ProfileRequestError("Request body must be a JSON object.");
  }

  return body as JobProfileInput;
}