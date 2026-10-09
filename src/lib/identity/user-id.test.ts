import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearUserId,
  getUserId,
  userFetch,
  __resetInMemoryUserId,
} from "@/lib/identity/demo-user";
import { resolveUserId } from "@/lib/identity/resolve-user-id";
import {
  createDemoUserId,
  DEMO_USER_ID_PREFIX,
  isValidUserId,
  LOCAL_USER_ID,
  MAX_USER_ID_LENGTH,
  USER_ID_HEADER,
  USER_ID_STORAGE_KEY,
  UserIdentityError,
} from "@/lib/identity/user-id";

/**
 * Identity tests.
 *
 * The properties that matter are behavioural, not structural: the same browser
 * keeps the same id across repeated reads and refreshes, every request carries
 * it, and a request without one is refused with a usable message instead of
 * being silently filed under somebody else's data.
 */

function requestWithUserId(value: string | null): Request {
  return new Request("https://app.test/api/profile", {
    headers: value === null ? {} : { [USER_ID_HEADER]: value },
  });
}

/** A `Storage` stand-in that behaves like the real thing, including throwing. */
function fakeStorage(options: { throws?: boolean } = {}) {
  const entries = new Map<string, string>();

  return {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    /** Lets a test simulate a value left behind by an older build. */
    seed: (key: string, value: string) => entries.set(key, value),
    entries,
    ...(options.throws
      ? {
          getItem: vi.fn(() => {
            throw new Error("SecurityError: storage is blocked");
          }),
          setItem: vi.fn(() => {
            throw new Error("SecurityError: storage is blocked");
          }),
          removeItem: vi.fn(() => {
            throw new Error("SecurityError: storage is blocked");
          }),
        }
      : {}),
  } satisfies Storage & { seed: (key: string, value: string) => void; entries: Map<string, string> };
}

type FakeStorage = ReturnType<typeof fakeStorage>;

/** Installs a fake browser so the client helpers see `window.localStorage`. */
function useBrowser(storage: FakeStorage): FakeStorage {
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
}

beforeEach(() => {
  __resetInMemoryUserId();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createDemoUserId", () => {
  it("produces an id the server would accept", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const id = createDemoUserId();

      expect(id.startsWith(DEMO_USER_ID_PREFIX)).toBe(true);
      expect(isValidUserId(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(MAX_USER_ID_LENGTH);
    }
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createDemoUserId()));

    expect(ids.size).toBe(50);
  });

  it("falls back when the platform has no randomUUID", () => {
    vi.stubGlobal("crypto", {});

    expect(isValidUserId(createDemoUserId())).toBe(true);
  });
});

describe("isValidUserId", () => {
  it("accepts the punctuation used by emails and provider ids", () => {
    for (const value of ["a.b", "a_b", "a-b", "a@b", "tenant:user", "Abc123"]) {
      expect(isValidUserId(value)).toBe(true);
    }
  });

  it("rejects empty, over-long, and unprintable values", () => {
    for (const value of ["", "a".repeat(MAX_USER_ID_LENGTH + 1), "has space", "café", "semi;colon"]) {
      expect(isValidUserId(value)).toBe(false);
    }
  });

  it("accepts a value at the length limit", () => {
    expect(isValidUserId("a".repeat(MAX_USER_ID_LENGTH))).toBe(true);
  });
});

describe("getUserId", () => {
  it("creates an id on first use and stores it", () => {
    const storage = useBrowser(fakeStorage());

    const id = getUserId();

    expect(isValidUserId(id)).toBe(true);
    expect(storage.getItem(USER_ID_STORAGE_KEY)).toBe(id);
  });

  it("returns the same id on every later read, as a refresh would", () => {
    const storage = useBrowser(fakeStorage());

    const first = getUserId();
    const second = getUserId();
    const third = getUserId();

    expect(second).toBe(first);
    expect(third).toBe(first);
    // Minting happened exactly once, so the stored value was reused rather than
    // overwritten with a new id on each read.
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("keeps the id a previous session left behind", () => {
    const storage = useBrowser(fakeStorage());
    storage.seed(USER_ID_STORAGE_KEY, `${DEMO_USER_ID_PREFIX}from-a-previous-visit`);

    expect(getUserId()).toBe(`${DEMO_USER_ID_PREFIX}from-a-previous-visit`);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("replaces a stored value the server would reject instead of sending it", () => {
    const storage = useBrowser(fakeStorage());
    storage.seed(USER_ID_STORAGE_KEY, "not a valid id");

    const id = getUserId();

    expect(isValidUserId(id)).toBe(true);
    expect(storage.getItem(USER_ID_STORAGE_KEY)).toBe(id);
  });

  it("still produces a usable id when storage is blocked", () => {
    useBrowser(fakeStorage({ throws: true }));

    const first = getUserId();
    const second = getUserId();

    expect(isValidUserId(first)).toBe(true);
    // Stable within the session even though nothing could be persisted.
    expect(second).toBe(first);
  });

  it("forgets the id on clearUserId so the next read mints a new one", () => {
    const storage = useBrowser(fakeStorage());

    const first = getUserId();
    clearUserId();

    expect(storage.getItem(USER_ID_STORAGE_KEY)).toBeNull();
    expect(getUserId()).not.toBe(first);
  });

  it("does not throw when clearUserId runs with storage blocked", () => {
    useBrowser(fakeStorage({ throws: true }));
    getUserId();

    expect(() => clearUserId()).not.toThrow();
  });
});

describe("userFetch", () => {
  it("sends the stored id on the request", async () => {
    useBrowser(fakeStorage());
    const id = getUserId();

    await userFetch("/api/profile");

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get(USER_ID_HEADER)).toBe(id);
  });

  it("sends the same id on every request", async () => {
    useBrowser(fakeStorage());

    await userFetch("/api/profile");
    await userFetch("/api/resume", { method: "POST" });

    const headers = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => new Headers(init.headers).get(USER_ID_HEADER));

    expect(headers[0]).toBe(headers[1]);
    expect(isValidUserId(headers[0]!)).toBe(true);
  });

  it("overrides a stale id supplied by the caller", async () => {
    useBrowser(fakeStorage());
    const id = getUserId();

    await userFetch("/api/profile", { headers: { [USER_ID_HEADER]: "someone-else" } });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get(USER_ID_HEADER)).toBe(id);
  });

  it("keeps the caller's method, body, and other headers", async () => {
    useBrowser(fakeStorage());

    await userFetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/profile");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe("{}");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });
});

describe("resolveUserId", () => {
  it("returns the trimmed header value", () => {
    expect(resolveUserId(requestWithUserId("  user-1  "))).toBe("user-1");
  });

  it("accepts an id minted by the browser", () => {
    expect(resolveUserId(requestWithUserId(createDemoUserId()))).toMatch(
      new RegExp(`^${DEMO_USER_ID_PREFIX}`),
    );
  });

  it("falls back to a local id outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveUserId(requestWithUserId(null))).toBe(LOCAL_USER_ID);

    vi.stubEnv("NODE_ENV", "test");
    expect(resolveUserId(requestWithUserId("   "))).toBe(LOCAL_USER_ID);
  });

  it("requires a header in production rather than sharing one profile", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => resolveUserId(requestWithUserId(null))).toThrow(UserIdentityError);
    expect(() => resolveUserId(requestWithUserId(null))).toThrow(/Missing x-job-radar-user-id/);
  });

  it("rejects an unsupported value and says which rule it broke", () => {
    // Non-ASCII beyond latin-1 cannot even be sent as a header value; latin-1
    // can, and must still be refused by the pattern.
    expect(() => resolveUserId(requestWithUserId("has space"))).toThrow(
      /letters, digits, and \. _ - @ :/,
    );
    expect(() => resolveUserId(requestWithUserId("café"))).toThrow(
      /letters, digits, and \. _ - @ :/,
    );
    expect(() => resolveUserId(requestWithUserId("a".repeat(MAX_USER_ID_LENGTH + 1)))).toThrow(
      /128 characters or fewer/,
    );
  });

  it("accepts a value at the length limit", () => {
    expect(resolveUserId(requestWithUserId("a".repeat(MAX_USER_ID_LENGTH)))).toHaveLength(
      MAX_USER_ID_LENGTH,
    );
  });

  it("distinguishes a missing id from an unusable one", () => {
    vi.stubEnv("NODE_ENV", "production");

    let missing: unknown;
    let invalid: unknown;
    try {
      resolveUserId(requestWithUserId(null));
    } catch (error) {
      missing = error;
    }
    try {
      resolveUserId(requestWithUserId("not a valid id"));
    } catch (error) {
      invalid = error;
    }

    expect((missing as UserIdentityError).code).toBe("missing");
    expect((invalid as UserIdentityError).code).toBe("invalid");
  });
});