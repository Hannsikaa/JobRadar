import { describe, expect, it } from "vitest";

import type { HttpGetter } from "@/lib/jobs/ats";
import {
  directJobId,
  discoverDirectPostings,
  harvestDirectSourceTargets,
  postingMatchesRoles,
  postingPostedAge,
  toNormalizedPosting,
} from "@/lib/jobs/direct-sources";
import type { NormalizedJob } from "@/lib/jobs/types";

/**
 * Employer-board discovery.
 *
 * The contracts under test are the safety rules, not the happy path: a board is
 * only queried when the provider returned a matching link, a posting only enters
 * when it matches a target role, one board's failure cannot break the scan, and
 * the caps are deterministic.
 */

function job(overrides: Partial<NormalizedJob> & { id: string }): NormalizedJob {
  return {
    fingerprint: `fp-${overrides.id}`,
    title: "Backend Engineer",
    company: "Acme",
    source: "Google Jobs",
    isFresh: true,
    isNew: false,
    relevanceScore: 50,
    relevanceReasons: [],
    ...overrides,
  };
}

function board(body: unknown, status = 200): HttpGetter {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

const NOW = new Date("2026-10-09T12:00:00.000Z");

describe("harvestDirectSourceTargets", () => {
  it("takes a board from the employer's own link, only when the tenant matches", () => {
    const acme = job({
      id: "j1",
      company: "Acme",
      applyOptions: [{ publisher: "Lever", url: "https://jobs.lever.co/acme/abc" }],
    });

    expect(harvestDirectSourceTargets([acme], 5)).toEqual([
      { platform: "lever", tenant: "acme", employer: "Acme", seededBy: ["j1"] },
    ]);
  });

  it("rejects a familiar ATS host whose tenant is a different employer", () => {
    const pinterest = job({
      id: "j1",
      company: "Pinterest",
      applyOptions: [{ publisher: "Lever", url: "https://jobs.lever.co/granite/abc" }],
    });

    expect(harvestDirectSourceTargets([pinterest], 5)).toEqual([]);
  });

  it("ignores non-ATS links and jobs with no employer name", () => {
    const linkedin = job({
      id: "j1",
      company: "Acme",
      applyOptions: [{ publisher: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1" }],
    });
    const anonymous = job({
      id: "j2",
      company: undefined,
      applyOptions: [{ publisher: "Lever", url: "https://jobs.lever.co/acme/abc" }],
    });

    expect(harvestDirectSourceTargets([linkedin, anonymous], 5)).toEqual([]);
  });

  it("collapses repeat boards and stops at the cap, in listing order", () => {
    const seed = (id: string, url: string) =>
      job({ id, company: "Acme", applyOptions: [{ publisher: "x", url }] });

    const targets = harvestDirectSourceTargets(
      [
        seed("j1", "https://jobs.lever.co/acme/a"),
        seed("j2", "https://jobs.lever.co/acme/b"),
        seed("j3", "https://jobs.ashbyhq.com/acme/a"),
        seed("j4", "https://job-boards.greenhouse.io/acme/jobs/1"),
      ],
      2
    );

    expect(targets.map((target) => target.tenant)).toEqual(["acme", "acme"]);
    expect(targets[0]).toMatchObject({ platform: "lever", seededBy: ["j1", "j2"] });
    expect(targets[1]).toMatchObject({ platform: "ashby" });
  });
});

describe("postingMatchesRoles", () => {
  it("matches by role family and rejects cross-family titles", () => {
    expect(postingMatchesRoles("Senior Backend Engineer", ["Software Engineer"])).toBe(true);
    expect(postingMatchesRoles("Account Executive", ["Software Engineer"])).toBe(false);
    expect(postingMatchesRoles("Registered Nurse", ["Data Scientist"])).toBe(false);
  });

  it("falls back to a distinctive shared token when a family is unknown", () => {
    expect(postingMatchesRoles("Founding Engineer", ["Software Engineer"])).toBe(true);
    expect(postingMatchesRoles("Engagement Lead", ["Software Engineer"])).toBe(false);
  });
});

describe("discoverDirectPostings", () => {
  const seed = job({
    id: "j1",
    company: "Acme",
    applyOptions: [{ publisher: "Lever", url: "https://jobs.lever.co/acme/1" }],
  });

  const deps = {
    now: NOW,
    maxTargets: 5,
    maxPostingsPerBoard: 10,
    maxTotalPostings: 10,
    concurrency: 2,
  };

  it("contributes only the postings that match a target role, and reports the board", async () => {
    const outcome = await discoverDirectPostings([seed], ["Backend Engineer"], {
      ...deps,
      get: board([
        {
          id: "1",
          text: "Senior Backend Engineer",
          categories: { location: "Remote" },
          createdAt: NOW.getTime() - 2 * 86_400_000,
          hostedUrl: "https://jobs.lever.co/acme/1",
        },
        {
          id: "2",
          text: "Account Executive",
          categories: { location: "Berlin" },
          hostedUrl: "https://jobs.lever.co/acme/2",
        },
      ]),
    });

    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.jobs[0]).toMatchObject({
      id: "ats:lever:acme:1",
      title: "Senior Backend Engineer",
      company: "Acme",
      source: "Lever",
      applyUrl: "https://jobs.lever.co/acme/1",
    });
    expect(outcome.jobs[0].posted).toEqual({ days: 2, text: "2026-10-07" });
    expect(outcome.reports).toEqual([
      { platform: "lever", tenant: "acme", employer: "Acme", status: "ok", returned: 2, matched: 1 },
    ]);
  });

  it("isolates a dead board: it reports the status and contributes nothing", async () => {
    const outcome = await discoverDirectPostings([seed], ["Backend Engineer"], {
      ...deps,
      get: board({}, 404),
    });

    expect(outcome.jobs).toEqual([]);
    expect(outcome.reports[0]).toMatchObject({ status: "not_found", matched: 0 });
  });

  it("enforces the total cap deterministically across boards", async () => {
    const multi = [
      job({
        id: "j1",
        company: "Acme",
        applyOptions: [{ publisher: "x", url: "https://jobs.lever.co/acme/1" }],
      }),
      job({
        id: "j2",
        company: "Beacon",
        applyOptions: [{ publisher: "x", url: "https://jobs.lever.co/beacon/1" }],
      }),
    ];

    const get: HttpGetter = async (url) => {
      const tenant = url.includes("beacon") ? "beacon" : "acme";
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: "1", text: "Backend Engineer", hostedUrl: `https://jobs.lever.co/${tenant}/1` },
          { id: "2", text: "Backend Engineer", hostedUrl: `https://jobs.lever.co/${tenant}/2` },
        ],
      };
    };

    const outcome = await discoverDirectPostings(multi, ["Backend Engineer"], {
      ...deps,
      maxTotalPostings: 2,
      get,
    });

    expect(outcome.jobs).toHaveLength(2);
    expect(outcome.jobs.map((entry) => entry.id).sort()).toEqual([
      "ats:lever:acme:1",
      "ats:lever:acme:2",
    ]);
  });

  it("does nothing when there are no roles or no targets", async () => {
    const noRoles = await discoverDirectPostings([seed], [], { ...deps, get: board([]) });
    expect(noRoles).toEqual({ jobs: [], reports: [] });

    const noTargets = await discoverDirectPostings(
      [job({ id: "j1", company: "Acme" })],
      ["Backend Engineer"],
      { ...deps, get: board([]) }
    );
    expect(noTargets).toEqual({ jobs: [], reports: [] });
  });
});

describe("direct posting helpers", () => {
  it("derives a stable id and an honest age", () => {
    const posting = {
      platform: "greenhouse" as const,
      tenant: "acme",
      postingId: "9",
      title: "Software Engineer",
      url: "https://job-boards.greenhouse.io/acme/jobs/9",
      publishedAt: "2026-10-01T00:00:00.000Z",
    };

    expect(directJobId(posting)).toBe("ats:greenhouse:acme:9");
    expect(postingPostedAge(posting, NOW)).toEqual({ days: 8, text: "2026-10-01" });
    expect(toNormalizedPosting(posting, "Acme", NOW).company).toBe("Acme");
  });

  it("treats a stale or absent date as unknown", () => {
    const old = {
      platform: "greenhouse" as const,
      tenant: "acme",
      postingId: "9",
      title: "Software Engineer",
      url: "https://job-boards.greenhouse.io/acme/jobs/9",
      publishedAt: "2024-01-01T00:00:00.000Z",
    };

    expect(postingPostedAge(old, NOW)).toBeNull();
    expect(postingPostedAge({ ...old, publishedAt: undefined }, NOW)).toBeNull();
  });
});
