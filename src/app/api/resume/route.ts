import { respondWithResumeError } from "@/app/api/resume/error-response";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import { getCurrentResumeFileByUserId } from "@/lib/resume/repository";
import { ResumeMissingFileError, ResumeRequestError } from "@/lib/resume/errors";
import { toResumeUploadError, uploadResume } from "@/lib/resume/service";
import { RESUME_FILE_FIELD, toResumeFileMetadata } from "@/lib/resume/types";

/**
 * GET /api/resume — report the caller's current resume.
 * POST /api/resume — store an uploaded PDF or DOCX for the caller.
 *
 * GET answers "does this user already have a resume?" with `200` and either the
 * metadata or `resume: null`, rather than a 404. The question a returning user
 * asks is not "fetch resume 3f6b…" but "is there anything here yet?", and a
 * missing resume is a normal first-visit state rather than a failure. Only the
 * public metadata is returned; the storage key never leaves the server.
 *
 * POST's body must be `multipart/form-data` with the file under the `resume`
 * field. `request.formData()` is the supported way to read that: hand-rolling a
 * multipart parser would add a large, unmaintained surface for no benefit.
 *
 * Note the trade-off that comes with it — the runtime buffers the part before we
 * see it, so the size limit is enforced *after* the body is read rather than
 * while it streams in. The limit therefore bounds what is validated and stored,
 * not the raw bytes a client can put on the wire.
 *
 * Uploading again replaces the current resume: the response reports
 * `replaced: true` so the caller knows the profile it may still be holding was
 * derived from the previous file. See `@/lib/profile/state` for how staleness is
 * decided.
 *
 * Identity comes from the shared demo-identity header, because authentication is
 * not implemented yet. See `@/lib/identity/user-id`.
 *
 * The response contains the public metadata only; the storage key, the path on
 * disk, and the file contents never leave the server.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const userId = readUserId(request);
    const stored = await getCurrentResumeFileByUserId(userId);

    return Response.json(
      { resume: stored === null ? null : toResumeFileMetadata(stored) },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    return respondWithResumeError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const userId = readUserId(request);
    const file = await readResumeFile(request);

    const { resume, profileLinked, replaced } = await uploadResume(userId, file);

    return Response.json({ resume, profileLinked, replaced }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return respondWithResumeError(toResumeUploadError(error));
  }
}

/**
 * Resolves the caller, translating the identity shim's error into this
 * endpoint's own request error.
 *
 * The shim throws its own error type because it serves several endpoints; both
 * routes here describe the same mistake, so both answer 400 with an
 * `invalid_request` code instead of reporting the upload as broken.
 *
 * The shim's own message is deliberately dropped rather than forwarded: it names
 * the internal header identity is read from, and it can also carry a database
 * error whose text contains a connection string. The caller gets a fixed
 * sentence, and the original error stays on `cause` for the server log.
 */
function readUserId(request: Request): string {
  try {
    return resolveUserId(request);
  } catch (error) {
    throw new ResumeRequestError("The request could not be attributed to a user.", { cause: error });
  }
}

/**
 * Pulls the resume out of a multipart request.
 *
 * A body that is not multipart at all is a request error: the caller used the
 * wrong content type, which is a different mistake from sending a multipart
 * body with a bad file in it.
 */
async function readResumeFile(request: Request): Promise<File> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    throw new ResumeRequestError(
      "Request body must be multipart/form-data with a file under the \"resume\" field.",
      { cause: error },
    );
  }

  const entry = formData.get(RESUME_FILE_FIELD);

  // `get` returns a string for a plain form field, which is not a file upload.
  if (!(entry instanceof File)) {
    throw new ResumeMissingFileError();
  }

  return entry;
}