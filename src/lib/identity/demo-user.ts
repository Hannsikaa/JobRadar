"use client";

/**
 * The browser half of the demo identity.
 *
 * One rule for the whole app: **no component calls `fetch` on our own API
 * directly.** Everything goes through {@link userFetch}, which attaches the
 * stored demo user id. That is what stops the app from producing several
 * different identities for the same browser — the failure mode where a profile
 * is written under one id and read back under another.
 *
 * The id is generated on first use and kept in `localStorage`, so it survives
 * page refreshes, navigation, and closing the tab. It is never regenerated
 * afterwards, and the user never types it.
 */

import {
  createDemoUserId,
  isValidUserId,
  USER_ID_HEADER,
  USER_ID_STORAGE_KEY,
} from "@/lib/identity/user-id";

/**
 * Id used when `localStorage` is unavailable.
 *
 * Private browsing windows and blocked third-party storage can make
 * `localStorage` throw rather than return `null`. Rather than failing the
 * request, the page keeps working for this session with an id held in memory.
 * The user is then anonymous again on the next tab — an acceptable trade for a
 * demo, and far better than a broken upload.
 */
let inMemoryUserId: string | null = null;

/** Returns `window.localStorage`, or `null` when it is unavailable or throws. */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Returns the stable demo user id for this browser, minting one on first use.
 *
 * Safe to call during server rendering only in the sense that it returns an
 * ephemeral id there; call sites are effects and event handlers, so the value
 * they act on is always the browser's.
 */
export function getUserId(): string {
  const storage = browserStorage();

  if (storage === null) {
    inMemoryUserId ??= createDemoUserId();
    return inMemoryUserId;
  }

  try {
    const stored = storage.getItem(USER_ID_STORAGE_KEY);

    if (stored !== null && isValidUserId(stored)) {
      return stored;
    }

    const created = createDemoUserId();
    storage.setItem(USER_ID_STORAGE_KEY, created);
    return created;
  } catch {
    inMemoryUserId ??= createDemoUserId();
    return inMemoryUserId;
  }
}

/**
 * Forgets the demo user id, so the next request mints a new one.
 *
 * Exists for tests and for a deliberate "start over" affordance; ordinary
 * navigation never calls it.
 */
export function clearUserId(): void {
  inMemoryUserId = null;

  const storage = browserStorage();
  if (storage === null) {
    return;
  }

  try {
    storage.removeItem(USER_ID_STORAGE_KEY);
  } catch {
    // Nothing to do: the in-memory id is already gone, and a storage we cannot
    // write to will not have kept an id either.
  }
}

/**
 * `fetch` with the demo user id attached.
 *
 * Drop-in replacement for `fetch` on our own endpoints. A caller-supplied
 * `x-job-radar-user-id` header is overwritten rather than trusted, so every
 * request from this browser is attributed to the same user even if a stale
 * header is left over from a copied `RequestInit`.
 */
export function userFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(USER_ID_HEADER, getUserId());

  return fetch(input, { ...init, headers });
}

/**
 * Test-only hook: drops the in-memory fallback id.
 *
 * Exposed so a test can assert that a fresh browser starts from a clean slate
 * without needing a real `localStorage`. Not intended for application code.
 */
export function __resetInMemoryUserId(): void {
  inMemoryUserId = null;
}