import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCache } from "@/lib/env";
import {
  GOOGLE_JOBS_ENGINE,
  MAX_PAGES_PER_SEARCH,
  redactUrl,
  searchGoogleJobs,
  searchGoogleJobsPages,
  SerpApiError,
} from "@/lib/serpapi/client";

/**
 * Tests for the SerpApi client.
 *
 * `fetch` is stubbed in every case: these tests never touch the network, and a
 * test that did would cost money and be flaky. The URL is asserted rather than
 * discarded, because the URL is the thing most likely to leak the key.
 *
 * The highest-value assertions in this file are the negative ones: that a failure
 * never carries the key in its message or its `detail`, and that a malformed
 * provider body is rejected rather than trusted.
 */

const API_KEY = "test-key-do-not-log-1234567890";

/** A minimal valid Google Jobs response. */
function jobsBody(overrides: Record<string, unknown> = {}) {
  return {
    search_metadata: { id: "abc", status: "Success" },
    search_parameters: { q: "software developer", engine: GOOGLE_JOBS_ENGINE },
    jobs_results: [
      {
        job_id: "j1",
        title: "Software Developer",
        company_name: "Acme",
        location: "Hyderabad, India",
      },
    ],
    ...overrides,
  };
}

/** Builds a `Response` with a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setEnv(values: Record<string, string | undefined>) {
  for (const key of ["SERPAPI_API_KEY", "SERPAPI_BASE_URL"]) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  __resetEnvCache();
}

/** The URL the stubbed `fetch` was called with, parsed for assertions. */
function calledUrl(call = 0): URL {
  const input = vi.mocked(fetch).mock.calls[call]?.[0];

  return new URL(String(input));
}

beforeEach(() => {
  setEnv({ SERPAPI_API_KEY: API_KEY });
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(jobsBody())));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setEnv({});
  vi.restoreAllMocks();
});

describe("searchGoogleJobs", () => {
  it("requests the google_jobs engine with the key on the wire", async () => {
    const response = await searchGoogleJobs({ q: "software developer" });

    expect(response.jobs_results).toHaveLength(1);

    const url = calledUrl();
    expect(url.pathname).toContain("search.json");
    expect(url.searchParams.get("engine")).toBe(GOOGLE_JOBS_ENGINE);
    expect(url.searchParams.get("q")).toBe("software developer");
    expect(url.searchParams.get("api_key")).toBe(API_KEY);
  });

  it("uses SERPAPI_BASE_URL when it is configured", async () => {
    setEnv({ SERPAPI_API_KEY: API_KEY, SERPAPI_BASE_URL: "https://proxy.example.com/api/" });

    await searchGoogleJobs({ q: "software developer" });

    expect(calledUrl().origin).toBe("https://proxy.example.com");
    expect(calledUrl().pathname).toBe("/api/search.json");
  });

  it("passes location as its own parameter rather than appending it to q", async () => {
    await searchGoogleJobs({ q: "software developer", location: "Hyderabad, India" });

    const url = calledUrl();
    expect(url.searchParams.get("location")).toBe("Hyderabad, India");
    // Appending to both would double-count the location in SerpApi's own logs.
    expect(url.searchParams.get("q")).toBe("software developer");
  });

  it("rejects with not_configured when no key is set", async () => {
    setEnv({});

    const error = await searchGoogleJobs({ q: "software developer" }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(SerpApiError);
    expect(error.kind).toBe("not_configured");
    expect(error.status).toBe(503);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a blank query before spending a request", async () => {
    const error = await searchGoogleJobs({ q: "   " }).catch((thrown) => thrown);

    expect(error.kind).toBe("bad_request");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("classifies a 429 as rate_limited and answers 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Too many requests" }, 429)));

    const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

    expect(error.kind).toBe("rate_limited");
    expect(error.status).toBe(429);
  });

  it("treats a quota error inside a 200 body as rate_limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Your account has run out of searches per month." }))
    );

    const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

    expect(error.kind).toBe("rate_limited");
  });

  it("classifies a 5xx as unavailable and answers 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Server error" }, 503)));

    const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

    expect(error.kind).toBe("unavailable");
    expect(error.status).toBe(502);
  });

  it("classifies a network failure as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

    expect(error.kind).toBe("unavailable");
    expect(error.status).toBe(502);
  });

  it("rejects a 200 body that is not a Google Jobs payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ something: "else entirely" })));

    const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

    expect(error.kind).toBe("malformed_response");
    expect(error.status).toBe(502);
  });

  it("accepts an empty jobs_results as a valid zero-result search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ search_metadata: { status: "Success" }, jobs_results: [] })
      )
    );

    const response = await searchGoogleJobs({ q: "x" });

    expect(response.jobs_results).toEqual([]);
  });

  it("treats SerpApi's no-results error in a successful search as an empty answer", async () => {
    // Google Jobs reports "nothing matched" as an `error` string inside a 200
    // body while search_metadata says the search succeeded. That is a real
    // answer, not a failure — the pipeline must not turn it into a 502.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          search_metadata: { status: "Success" },
          search_information: { jobs_results_state: "Fully empty" },
          error: "Google hasn't returned any results for this query.",
        })
      )
    );

    const response = await searchGoogleJobs({ q: "x" });

    expect(response.jobs_results ?? []).toEqual([]);
  });

  it("still throws when the no-results wording arrives without a successful search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          error: "Google hasn't returned any results for this query.",
        })
      )
    );

    const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(SerpApiError);
    expect(error.kind).toBe("bad_request");
  });

  it("rejects a body that is not JSON at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway</html>", { status: 200 }))
    );

    const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

    expect(error.kind).toBe("malformed_response");
  });

  describe("credential safety", () => {
    it("never puts the API key in an error message", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "bad request" }, 400)));

      const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

      expect(error.message).not.toContain(API_KEY);
      expect(JSON.stringify(error.detail ?? null)).not.toContain(API_KEY);
    });

    it("redacts the key from a provider body that echoes the request", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(
            { error: `Invalid request: https://serpapi.com/search.json?api_key=${API_KEY}&engine=google_jobs` },
            400
          )
        )
      );

      const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

      expect(error.message).not.toContain(API_KEY);
      expect(JSON.stringify(error.detail)).not.toContain(API_KEY);
      expect(JSON.stringify(error.detail)).toContain("REDACTED");
    });

    it("redacts the key from the url kept on a network failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        })
      );

      const error = await searchGoogleJobs({ q: "x" }).catch((thrown) => thrown);

      expect(JSON.stringify(error.detail)).not.toContain(API_KEY);
    });
  });
});

describe("searchGoogleJobsPages", () => {
  it("returns a single page when there is no next_page_token", async () => {
    const { jobs, pagesFetched } = await searchGoogleJobsPages({ q: "x" }, 2);

    expect(pagesFetched).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("follows next_page_token up to the requested limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          jobsBody({
            jobs_results: [{ job_id: "p", title: "Page job" }],
            serpapi_pagination: { next_page_token: "token-2" },
          })
        )
      )
    );

    const { pagesFetched } = await searchGoogleJobsPages({ q: "x" }, 2);

    expect(pagesFetched).toBe(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(calledUrl(1).searchParams.get("next_page_token")).toBe("token-2");
  });

  it("never exceeds MAX_PAGES_PER_SEARCH even when asked for more", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          jobsBody({
            serpapi_pagination: { next_page_token: "always-another-page" },
          })
        )
      )
    );

    const { pagesFetched } = await searchGoogleJobsPages({ q: "x" }, 99);

    expect(pagesFetched).toBe(MAX_PAGES_PER_SEARCH);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(MAX_PAGES_PER_SEARCH);
  });

  it("treats a page budget below one as a single page", async () => {
    const { pagesFetched } = await searchGoogleJobsPages({ q: "x" }, 0);

    expect(pagesFetched).toBe(1);
  });

  it("keeps the pages already fetched when a later page fails", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;

        if (call === 1) {
          return jsonResponse(
            jobsBody({
              serpapi_pagination: { next_page_token: "token-2" },
            })
          );
        }

        return jsonResponse({ error: "unavailable" }, 500);
      })
    );

    // A later-page failure propagates, but the caller can still use `rawCount`
    // from the attempts it already recorded. This asserts the shape of the
    // failure rather than a partial return: discarding a good first page would be
    // worse than surfacing the error.
    await expect(searchGoogleJobsPages({ q: "x" }, 2)).rejects.toBeInstanceOf(SerpApiError);
    expect(call).toBe(2);
  });
});

describe("redactUrl", () => {
  it("replaces the api_key value but keeps the readable parameters", () => {
    const redacted = redactUrl(
      "https://serpapi.com/search.json?engine=google_jobs&q=dev&location=Hyderabad&api_key=SECRET"
    );

    expect(redacted).not.toContain("SECRET");
    expect(redacted).toContain("REDACTED");
    // Debugging a failing search needs the engine and location to survive.
    expect(redacted).toContain("engine=google_jobs");
    expect(redacted).toContain("location=Hyderabad");
  });

  it("does not mangle a URL that has no api_key", () => {
    const url = "https://serpapi.com/search.json?engine=google_jobs";

    expect(redactUrl(url)).toContain("engine=google_jobs");
  });

  it("redacts rather than leaking when the URL cannot be parsed", () => {
    const redacted = redactUrl("not a url?api_key=SECRET");

    expect(redacted).not.toContain("SECRET");
  });
});