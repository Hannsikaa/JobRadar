import { isUserConfigurationError, JobSearchError } from "@/lib/jobs/errors";
import { searchJobsForUser } from "@/lib/jobs/search";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import { UserIdentityError } from "@/lib/identity/user-id";
import { ProfileStoreError, ProfileStoreUnavailableError } from "@/lib/profile/errors";

/**
 * GET /api/jobs/search — run a discovery scan for the caller.
 *
 * The response is `{ jobs, metadata, attempts }`. Three things about it are worth
 * stating because they are what make it trustworthy:
 *
 * 1. **A partial scan is a 200.** `metadata.failedSearchCount > 0` alongside a
 *    non-empty `jobs` is a real, usable answer, not an error. `attempts` says
 *    which queries failed and why.
 * 2. **Zero jobs is a 200.** A scan that ran and matched nothing has told the user
 *    something true.
 * 3. **No fallback list.** If SerpApi is unreachable this route returns an error.
 *    It never substitutes invented jobs, and the message says which layer failed.
 *
 * Every response is `no-store`: results are different on every scan, and a cached
 * page would quietly show the previous run's jobs.
 *
 * The heavy lifting lives in `searchJobsForUser`, the single orchestrator that
 * owns the pipeline order (profile → plan → SerpApi → normalize → dedupe →
 * freshness → salary → experience → score). This route only resolves identity,
 * delegates, and maps errors to HTTP responses.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  let userId: string;

  try {
    userId = resolveUserId(request);
  } catch (error) {
    // No user, so no profile to search for. 401 rather than the search error the
    // orchestrator would raise, because the caller's identity is the actual
    // problem and it should not read as "your profile is incomplete".
    return json(
      {
        error: {
          code: "unauthenticated",
          message:
            error instanceof UserIdentityError
              ? "The request could not be attributed to a user. Reload the page and try again."
              : "The request could not be attributed to a user.",
        },
      },
      401
    );
  }

  try {
    const result = await searchJobsForUser(userId, { now: new Date() });
    return json({ jobs: result.jobs, metadata: result.metadata, attempts: result.attempts }, 200);
  } catch (error) {
    return respondWithSearchError(error);
  }
}

/**
 * Turns a pipeline failure into the shared error envelope.
 *
 * A profile-store failure is remapped rather than passed through: the store
 * raises it for both "the database is down" and "the stored document no longer
 * matches the schema", and a caller should see one honest message about the
 * profile instead of an error code that leaks which schema field drifted.
 */
function respondWithSearchError(error: unknown): Response {
  if (error instanceof JobSearchError) {
    // An unanswered question about the user's own profile is normal operation and
    // does not deserve an error-level log. A provider failure does.
    const log = isUserConfigurationError(error) ? console.warn : console.error;
    log(`[jobs] ${error.code}: ${error.message}`, { cause: error.cause });

    return json({ error: { code: error.code, message: error.message } }, error.status);
  }

  if (error instanceof ProfileStoreUnavailableError || error instanceof ProfileStoreError) {
    console.error("[jobs] profile could not be read", error);

    return json(
      {
        error: {
          code: "profile_unavailable",
          message: "Your profile could not be read, so no search could be run.",
        },
      },
      503
    );
  }

  console.error("[jobs] unhandled failure", error);

  return json(
    { error: { code: "internal_error", message: "The job search could not be completed." } },
    500
  );
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE }) as Response;
}