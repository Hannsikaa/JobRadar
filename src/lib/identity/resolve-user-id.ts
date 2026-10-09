import {
  isValidUserId,
  LOCAL_USER_ID,
  MAX_USER_ID_LENGTH,
  USER_ID_HEADER,
  USER_ID_PATTERN,
  UserIdentityError,
} from "@/lib/identity/user-id";

/**
 * The server half of the demo identity.
 *
 * Reads the id the browser attached to a request and decides whether the request
 * can be trusted to name a user.
 *
 * Outside production a missing id falls back to {@link LOCAL_USER_ID}: the app
 * has no sign-in yet, and refusing every request would make it unusable from
 * curl, tests, and server-rendered pages. In production a missing id is a client
 * error instead, because falling back would collapse every anonymous caller onto
 * a single shared profile — their resumes and profiles would overwrite each
 * other. That distinction is the only reason this function is not a one-liner.
 *
 * The caller turns a {@link UserIdentityError} into its own domain error, so the
 * message here is written for the server log and the response message is
 * decided at the route.
 */

export function resolveUserId(request: Request): string {
  const rawValue = request.headers.get(USER_ID_HEADER);
  const candidate = typeof rawValue === "string" ? rawValue.trim() : "";

  if (candidate.length === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new UserIdentityError(
        "missing",
        `Missing ${USER_ID_HEADER} header. Authentication is not implemented yet; send a temporary user id until sign-in exists.`,
      );
    }

    return LOCAL_USER_ID;
  }

  if (!isValidUserId(candidate)) {
    throw new UserIdentityError("invalid", `Invalid ${USER_ID_HEADER} header: ${describeRejection(candidate)}`);
  }

  return candidate;
}

/**
 * Explains why a candidate was refused, in the caller's own terms.
 *
 * Split out so the rules stay in `user-id.ts` and this file only reports them:
 * an over-long id and a badly punctuated id are different mistakes, and a
 * message that names which one lets the caller fix it.
 */
function describeRejection(candidate: string): string {
  if (candidate.length > MAX_USER_ID_LENGTH) {
    return `user id must be ${MAX_USER_ID_LENGTH} characters or fewer`;
  }

  if (!USER_ID_PATTERN.test(candidate)) {
    return "user id may only contain letters, digits, and . _ - @ : characters";
  }

  return "unsupported value";
}