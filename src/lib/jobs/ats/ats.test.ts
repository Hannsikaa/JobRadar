import { describe, expect, it } from "vitest";

import { ashbyAdapter } from "@/lib/jobs/ats/ashby";
import { greenhouseAdapter } from "@/lib/jobs/ats/greenhouse";
import { leverAdapter } from "@/lib/jobs/ats/lever";
import { atsLocationOf, fetchBoard, getAdapter, type HttpGetter } from "@/lib/jobs/ats";

/**
 * The ATS adapters and the board fetcher.
 *
 * Fixtures mirror the real public payloads (captured live), so a shape change on
 * a platform surfaces here first. The point of every case is the same: read what
 * the board actually said, invent nothing, and turn every failure into a status
 * instead of a throw.
 */

function jsonResponse(body: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const getter = (
  body: unknown,
  status = 200
): { get: HttpGetter; urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get: async (url) => {
      urls.push(url);
      return jsonResponse(body, status);
    },
  };
};

describe("greenhouseAdapter.parse", () => {
  it("reads the documented payload shape", () => {
    const postings = greenhouseAdapter.parse(
      {
        jobs: [
          {
            id: 8860302002,
            title: "Senior Software Engineer",
            absolute_url: "https://job-boards.greenhouse.io/gitlab/jobs/8860302002",
            location: { name: "Remote, France" },
            updated_at: "2026-10-02T11:31:50-04:00",
            first_published: "2026-10-01T09:00:00-04:00",
            company_name: "GitLab",
          },
        ],
      },
      "gitlab"
    );

    expect(postings).toHaveLength(1);
    expect(postings?.[0]).toMatchObject({
      platform: "greenhouse",
      tenant: "gitlab",
      postingId: "8860302002",
      title: "Senior Software Engineer",
      url: "https://job-boards.greenhouse.io/gitlab/jobs/8860302002",
      location: "Remote, France",
      companyName: "GitLab",
    });
    expect(postings?.[0].publishedAt).toBe("2026-10-01T13:00:00.000Z");
  });

  it("skips entries missing a title, url, or id and never invents fields", () => {
    const postings = greenhouseAdapter.parse(
      {
        jobs: [
          { id: 1, title: "No URL" },
          { id: 2, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/2" },
          { title: "No id", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/3" },
          {
            id: 4,
            title: "Kept",
            absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4",
          },
        ],
      },
      "acme"
    );

    expect(postings).toHaveLength(1);
    expect(postings?.[0].postingId).toBe("4");
    expect(postings?.[0].location).toBeUndefined();
    expect(postings?.[0].publishedAt).toBeUndefined();
  });

  it("returns null for a payload that is not a greenhouse board", () => {
    expect(greenhouseAdapter.parse(null, "acme")).toBeNull();
    expect(greenhouseAdapter.parse({}, "acme")).toBeNull();
    expect(greenhouseAdapter.parse({ jobs: "nope" }, "acme")).toBeNull();
  });
});

describe("leverAdapter.parse", () => {
  it("reads the documented array shape", () => {
    const postings = leverAdapter.parse(
      [
        {
          id: "abc-123",
          text: "Backend Engineer",
          categories: {
            location: "Atlanta, Georgia",
            allLocations: ["Atlanta, Georgia", "Remote"],
            commitment: "Regular Full Time",
          },
          createdAt: 1788199939703,
          hostedUrl: "https://jobs.lever.co/acme/abc-123",
          applyUrl: "https://jobs.lever.co/acme/abc-123/apply",
          workplaceType: "remote",
        },
      ],
      "acme"
    );

    expect(postings).toHaveLength(1);
    expect(postings?.[0]).toMatchObject({
      platform: "lever",
      tenant: "acme",
      postingId: "abc-123",
      title: "Backend Engineer",
      url: "https://jobs.lever.co/acme/abc-123",
      location: "Atlanta, Georgia",
      remote: true,
    });
    expect(postings?.[0].publishedAt).toBe(new Date(1788199939703).toISOString());
  });

  it("returns null for anything that is not a lever board array", () => {
    expect(leverAdapter.parse({}, "acme")).toBeNull();
    expect(leverAdapter.parse(null, "acme")).toBeNull();
  });
});

describe("ashbyAdapter.parse", () => {
  it("reads listed postings and skips unlisted ones", () => {
    const postings = ashbyAdapter.parse(
      {
        jobs: [
          {
            id: "a1",
            title: "Software Engineer",
            location: "Remote (Europe)",
            publishedAt: "2026-09-20T00:00:00.000Z",
            isRemote: true,
            jobUrl: "https://jobs.ashbyhq.com/acme/a1",
            isListed: true,
          },
          {
            id: "a2",
            title: "Internal Only",
            jobUrl: "https://jobs.ashbyhq.com/acme/a2",
            isListed: false,
          },
        ],
      },
      "acme"
    );

    expect(postings).toHaveLength(1);
    expect(postings?.[0]).toMatchObject({
      platform: "ashby",
      postingId: "a1",
      title: "Software Engineer",
      remote: true,
    });
    expect(postings?.[0].publishedAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("returns null for a payload that is not an ashby board", () => {
    expect(ashbyAdapter.parse({}, "acme")).toBeNull();
    expect(ashbyAdapter.parse({ jobs: [] }, "acme")).toEqual([]);
    expect(ashbyAdapter.parse("nope", "acme")).toBeNull();
  });
});

describe("atsLocationOf", () => {
  it("reads platform and tenant from each supported host", () => {
    expect(atsLocationOf("https://job-boards.greenhouse.io/gitlab/jobs/123")).toEqual({
      platform: "greenhouse",
      tenant: "gitlab",
    });
    expect(atsLocationOf("https://boards-api.greenhouse.io/v1/boards/gitlab/jobs")).toEqual({
      platform: "greenhouse",
      tenant: "gitlab",
    });
    expect(atsLocationOf("https://jobs.lever.co/acme/abc-123")).toEqual({
      platform: "lever",
      tenant: "acme",
    });
    expect(atsLocationOf("https://jobs.ashbyhq.com/wayve/xyz")).toEqual({
      platform: "ashby",
      tenant: "wayve",
    });
  });

  it("returns null for non-ATS and unreadable URLs", () => {
    expect(atsLocationOf("https://www.linkedin.com/jobs/view/123")).toBeNull();
    expect(atsLocationOf("https://granite.wd1.myworkdayjobs.com/careers")).toBeNull();
    expect(atsLocationOf("not a url")).toBeNull();
    expect(atsLocationOf("https://boards.greenhouse.io/")).toBeNull();
  });

  it("exposes adapters by platform", () => {
    expect(getAdapter("greenhouse")).toBe(greenhouseAdapter);
    expect(getAdapter("lever")).toBe(leverAdapter);
    expect(getAdapter("ashby")).toBe(ashbyAdapter);
  });
});

describe("fetchBoard", () => {
  it("requests the platform's documented board URL", async () => {
    const { get, urls } = getter({ jobs: [] });
    const result = await fetchBoard({ platform: "greenhouse", tenant: "acme" }, { get });

    expect(urls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs"]);
    expect(result.status).toBe("empty");
  });

  it("maps HTTP and transport failures to statuses instead of throwing", async () => {
    const notFound = await fetchBoard(
      { platform: "lever", tenant: "ghost" },
      { get: async () => jsonResponse({}, 404) }
    );
    expect(notFound.status).toBe("not_found");

    const limited = await fetchBoard(
      { platform: "lever", tenant: "acme" },
      { get: async () => jsonResponse({}, 429) }
    );
    expect(limited.status).toBe("rate_limited");

    const unavailable = await fetchBoard(
      { platform: "lever", tenant: "acme" },
      { get: async () => jsonResponse({}, 500) }
    );
    expect(unavailable.status).toBe("unavailable");

    const thrown = await fetchBoard(
      { platform: "lever", tenant: "acme" },
      {
        get: async () => {
          throw new Error("socket closed");
        },
      }
    );
    expect(thrown.status).toBe("unavailable");
  });

  it("treats an unreadable or unexpected body as malformed", async () => {
    const unreadable = await fetchBoard(
      { platform: "greenhouse", tenant: "acme" },
      { get: async () => ({ ok: true, status: 200, json: async () => { throw new Error("no json"); } }) }
    );
    expect(unreadable.status).toBe("malformed");

    const unexpected = await fetchBoard(
      { platform: "greenhouse", tenant: "acme" },
      { get: async () => jsonResponse({ nope: true }) }
    );
    expect(unexpected.status).toBe("malformed");
  });

  it("reports a body read cut short by the timeout as unavailable, not malformed", async () => {
    const result = await fetchBoard(
      { platform: "ashby", tenant: "wayve" },
      {
        timeoutMs: 5,
        get: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            throw new Error("aborted");
          },
        }),
      }
    );

    expect(result.status).toBe("unavailable");
  });

  it("returns the postings on a good response", async () => {
    const { get } = getter({
      jobs: [
        {
          id: 1,
          title: "Software Engineer",
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1",
        },
      ],
    });
    const result = await fetchBoard({ platform: "greenhouse", tenant: "acme" }, { get });

    expect(result.status).toBe("ok");
    expect(result.postings).toHaveLength(1);
  });
});
