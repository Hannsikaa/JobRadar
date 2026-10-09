/**
 * The identity contract for the local demo.
 *
 * This is the single source of truth for *what a user id is* and *how it travels
 * between the browser and the API*. Both halves of the app import from here, so
 * the browser and the server can never disagree about the header name, the
 * character rules, or the length limit.
 *
 * There is deliberately no authentication in this MVP. A "user" is a random id
 * minted by the browser and kept in `localStorage`. Anyone who can reach the app
 * can present any id — this is a placeholder that lets the profile and resume
 * models be built end to end, not a security boundary.
 *
 * Environment-free by design: this module touches neither `window` nor
 * `Request`. The two environments live in `./demo-user` (browser) and
 * `./resolve-user-id` (server).
 */

/**
 * Header the browser sends its user id in, and the server reads it from.
 *
 * Kept here so a rename cannot leave the client and server on different names —
 * the bug that previously produced "the request could not be attributed to a
 * user" on one side while the other side looked correct.
 */
export const USER_ID_HEADER = "x-job-radar-user-id";

/** `localStorage` key holding the demo user's id. Namespaced to this app. */
export const USER_ID_STORAGE_KEY = "job-radar:user-id";

/**
 * Identity used when no header was sent and we are not in production.
 *
 * Lets curl, tests, and a server-rendered page reach the API without inventing
 * a browser-side id. It is deliberately *not* used in production, where a
 * missing id is a client error rather than a silent collapse of every anonymous
 * caller onto one shared profile.
 */
export const LOCAL_USER_ID = "local-user";

/** Prefix on every browser-minted id, so stored values are self-describing. */
export const DEMO_USER_ID_PREFIX = "demo-";

/**
 * Upper bound on an id's length.
 *
 * The value is used as a MongoDB key and a log correlation id, so it has to stay
 * small enough to be cheap and free of anything that needs escaping.
 */
export const MAX_USER_ID_LENGTH = 128;

/**
 * Permits letters, digits and the punctuation that appears in emails, handles
 * and provider ids. Anything else is rejected so the value stays usable as a
 * database key and never needs escaping in a header or a log line.
 */
export const USER_ID_PATTERN = /^[A-Za-z0-9._:@-]+$/;

/** Why a request could not be attributed to a user. */
export type UserIdentityErrorCode = "missing" | "invalid";

/**
 * A request arrived without a usable identity.
 *
 * Thrown by `resolveUserId` and translated by each route into its own domain
 * error, so the profile API answers with a profile code and the resume APIs
 * with a resume code. The message names the header because that is the one
 * concrete thing the caller can fix; it never carries a driver error, a
 * connection string, or any other server-side detail.
 */
export class UserIdentityError extends Error {
  readonly code: UserIdentityErrorCode;

  constructor(code: UserIdentityErrorCode, message: string) {
    super(message);
    this.name = "UserIdentityError";
    this.code = code;
  }
}

/**
 * Whether a value is usable as a user id.
 *
 * The single rule used by both sides: the browser validates what it is about to
 * store so it cannot persist a value the server would later reject, and the
 * server validates what it receives.
 */
export function isValidUserId(value: string): boolean {
  return (
    value.length >= 1 && value.length <= MAX_USER_ID_LENGTH && USER_ID_PATTERN.test(value)
  );
}

/**
 * Mints a random, self-describing demo user id.
 *
 * Uses `crypto.randomUUID()` where available and falls back to `Math.random`
 * plus the clock, which is enough for a local demo id: its job is to be stable
 * and unique per browser, not unguessable. The result is re-checked against
 * {@link isValidUserId} because an id the server would reject is worse than no
 * id at all.
 */
export function createDemoUserId(): string {
  const id = `${DEMO_USER_ID_PREFIX}${randomToken()}`;

  return isValidUserId(id) ? id : `${DEMO_USER_ID_PREFIX}${Date.now().toString(36)}`;
}

function randomToken(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  return `${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}