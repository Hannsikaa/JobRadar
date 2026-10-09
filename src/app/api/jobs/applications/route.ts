import { listAppliedJobIds, setJobApplied } from "@/lib/jobs/applications";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import { UserIdentityError } from "@/lib/identity/user-id";

/**
 * GET  /api/jobs/applications — the caller's applied job ids.
 * POST /api/jobs/applications — mark one job applied or not applied.
 *
 * Application status is per-user state, so both verbs resolve identity the same
 * way every other endpoint does and never fall back to a shared user.
 *
 * The store is best-effort on purpose. If MongoDB is unconfigured or briefly
 * unreachable, the GET still answers `200 { applied: [], available: false }` so a
 * results page renders, and the POST answers `503` so the client can revert its
 * optimistic mark rather than showing a checkmark that was never saved. A
 * missing mark is a smaller lie than a fabricated one.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * The longest job id we accept.
 *
 * SerpApi ids are not short slugs: they are a `serpapi:` prefix followed by a
 * base64 blob of the listing's parameters, and real ones run past 700
 * characters. The cap exists only to reject an absurd payload, so it is set well
 * above any id the pipeline actually produces.
 */
const MAX_JOB_ID_LENGTH = 4096;

export async function GET(request: Request): Promise<Response> {
  let userId: string;

  try {
    userId = resolveUserId(request);
  } catch (error) {
    return unauthenticated(error);
  }

  const { available, appliedIds } = await listAppliedJobIds(userId);

  return json({ applied: [...appliedIds], available }, 200);
}

export async function POST(request: Request): Promise<Response> {
  let userId: string;

  try {
    userId = resolveUserId(request);
  } catch (error) {
    return unauthenticated(error);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return json(
      { error: { code: "invalid_body", message: "Expected a JSON request body." } },
      400
    );
  }

  const parsed = readBody(body);

  if (parsed === null) {
    return json(
      {
        error: {
          code: "invalid_body",
          message: "Expected { jobId: string, applied: boolean }.",
        },
      },
      400
    );
  }

  const saved = await setJobApplied(userId, parsed.jobId, parsed.applied);

  if (!saved) {
    return json(
      {
        error: {
          code: "applications_unavailable",
          message: "Your application status could not be saved. Try again in a moment.",
        },
      },
      503
    );
  }

  return json({ jobId: parsed.jobId, applied: parsed.applied, available: true }, 200);
}

/** Validates the POST body, returning `null` when it is not usable. */
function readBody(body: unknown): { jobId: string; applied: boolean } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const { jobId, applied } = body as { jobId?: unknown; applied?: unknown };

  if (
    typeof jobId !== "string" ||
    jobId.trim().length === 0 ||
    jobId.length > MAX_JOB_ID_LENGTH ||
    typeof applied !== "boolean"
  ) {
    return null;
  }

  return { jobId, applied };
}

function unauthenticated(error: unknown): Response {
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

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE }) as Response;
}
