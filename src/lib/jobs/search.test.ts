import { beforeEach, describe, expect, it, vi } from "vitest";

import { searchJobsForUser, type SearchJobsOptions } from "@/lib/jobs/search";
import type { OfficialDiscoveryRunner } from "@/lib/jobs/official-discovery";
import type { SerpApiJobResult } from "@/lib/serpapi/client";
import { resumeProfileSchema } from "@/lib/profile/schemas";
import type { StoredProfile } from "@/lib/profile/types";

vi.mock("@/lib/profile/repository", () => ({ getProfileByUserId: vi.fn() }));
vi.mock("@/lib/jobs/discovery", () => ({
  markJobsSeen: vi.fn(async () => ({
    available: true,
    newFingerprints: new Set<string>(),
    seenFingerprints: new Set<string>(),
  })),
  recordScan: vi.fn(async () => true),
}));

import { getProfileByUserId } from "@/lib/profile/repository";
import { recordScan } from "@/lib/jobs/discovery";
import { buildFingerprint } from "@/lib/jobs/normalize";
import type { NormalizedJob } from "@/lib/jobs/types";

const mockedGetProfile = vi.mocked(getProfileByUserId);
const mockedRecordScan = vi.mocked(recordScan);

/**
 * Pipeline tests for the scan orchestrator.
 *
 * `fetchJobs` is injected so no test touches SerpApi, and the profile store is
 * mocked so no test needs MongoDB. What is under contract here:
 *
 * 1. A qualifier that starves a query is retried once with the bare role.
 * 2. A retried query that also fails does not turn a successful empty search
 *    into a failed attempt.
 * 3. A job with no readable posting age is retained but never marked fresh.
 */

function makeProfile(overrides: Partial<StoredProfile> = {}): StoredProfile {
  return {
    userId: "u1",
    // Parsed through the real schema so a missing field here fails loudly
    // instead of reaching the matcher as `undefined`.
    resume: resumeProfileSchema.parse({
      name: "Priya Sharma",
      skills: ["TypeScript", "Node.js"],
      technologies: ["MongoDB"],
      languages: ["English"],
      education: [],
      experience: [],
      projects: [],
      certifications: [],
    }),
    preferences: {
      targetRoles: ["Backend Engineer"],
      locations: ["Berlin, Germany"],
      experienceLevel: "entry",
      freshnessDays: 7,
    },
    ...overrides,
  } as StoredProfile;
}

function job(overrides: Partial<SerpApiJobResult> = {}): SerpApiJobResult {
  const suffix = Math.random().toString(36).slice(2);
  return {
    job_id: `j-${suffix}`,
    title: "Backend Engineer",
    company_name: "Acme",
    location: "Berlin, Germany",
    share_link: `https://example.com/jobs/${suffix}`,
    ...overrides,
  };
}

/** A job whose posting age Google reported. */
function jobWithAge(days: number): SerpApiJobResult {
  return job({ detected_extensions: { posted_at: days === 0 ? "just posted" : `${days} days ago` } });
}

function pages(jobs: SerpApiJobResult[]) {
  return { jobs, pagesFetched: 1 };
}

beforeEach(() => {
  mockedGetProfile.mockResolvedValue(makeProfile());
});

describe("searchJobsForUser", () => {
  it("retries a zero-result qualified query once with the bare role", async () => {
    const seen: string[] = [];
    const options: SearchJobsOptions = {
      fetchJobs: async (search) => {
        seen.push(search.q);
        // The qualified query starves; the bare role has results.
        return search.q === "Backend Engineer" ? pages([job()]) : pages([]);
      },
    };

    const result = await searchJobsForUser("u1", options);

    expect(seen).toEqual(["Backend Engineer entry level", "Backend Engineer"]);
    expect(result.metadata.total).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].query).toBe("Backend Engineer");
    expect(result.attempts[0].ok).toBe(true);
    expect(result.attempts[0].resultCount).toBe(1);
  });

  it("keeps a successful empty search successful when the retry also fails", async () => {
    const options: SearchJobsOptions = {
      fetchJobs: async (search) => {
        if (search.q !== "Backend Engineer") {
          return pages([]);
        }
        throw new Error("provider unreachable");
      },
    };

    const result = await searchJobsForUser("u1", options);

    expect(result.metadata.total).toBe(0);
    expect(result.metadata.failedSearchCount).toBe(0);
    expect(result.attempts[0].ok).toBe(true);
    expect(result.attempts[0].resultCount).toBe(0);
  });

  it("does not retry when the first query already returned results", async () => {
    const seen: string[] = [];
    const options: SearchJobsOptions = {
      fetchJobs: async (search) => {
        seen.push(search.q);
        return pages([job()]);
      },
    };

    await searchJobsForUser("u1", options);

    expect(seen).toEqual(["Backend Engineer entry level"]);
  });

  it("retains a job with no posting age but never marks it fresh", async () => {
    const options: SearchJobsOptions = {
      fetchJobs: async () => pages([job(), jobWithAge(1)]),
    };

    const result = await searchJobsForUser("u1", options);

    expect(result.metadata.total).toBe(2);

    const withoutAge = result.jobs.find((entry) => entry.posted === undefined);
    expect(withoutAge).toBeDefined();
    expect(withoutAge?.isFresh).toBe(false);

    const withAge = result.jobs.find((entry) => entry.posted !== undefined);
    expect(withAge?.isFresh).toBe(true);

    // Unknown ages are disclosed, not silently folded into "fresh".
    expect(result.metadata.unknownAgeCount).toBe(1);
    expect(result.metadata.freshCount).toBe(1);
  });

  it("persists the full scan payload so a refresh can restore it", async () => {
    mockedRecordScan.mockClear();

    const options: SearchJobsOptions = {
      fetchJobs: async () => pages([job(), jobWithAge(1)]),
    };

    await searchJobsForUser("u1", options);

    expect(mockedRecordScan).toHaveBeenCalledTimes(1);

    const [userId, summary] = mockedRecordScan.mock.calls[0];
    expect(userId).toBe("u1");
    // The payload `GET /api/jobs/last` redraws after a refresh.
    expect(summary.jobs).toHaveLength(2);
    expect(summary.metadata?.total).toBe(2);
    expect(summary.attempts).toHaveLength(1);
    // The fixture profile has no stored resume file; a real scan records the
    // one it ran against so a replacement can invalidate the record.
    expect(summary.resumeFileId).toBeNull();
  });

  it("throws when the scan cannot be attempted at all", async () => {
    mockedGetProfile.mockResolvedValue(null);

    await expect(searchJobsForUser("u1")).rejects.toMatchObject({
      code: "profile_not_found",
    });
  });

  it("attaches a verified official destination from the discovery stage", async () => {
    const destination = "https://www.acme.com/careers/1/backend-engineer";

    const runner: OfficialDiscoveryRunner = async (jobs) => {
      const first = jobs[0];
      if (first === undefined) {
        return new Map();
      }

      return new Map([
        [
          first.id,
          {
            jobId: first.id,
            status: "verified_official_job",
            evidence: ["Found on acme.com, the employer's own domain."],
            destination: {
              url: destination,
              kind: "official_company_site",
              provider: "acme.com",
              evidence: ["Found on acme.com, the employer's own domain."],
            },
          },
        ],
      ]);
    };

    const result = await searchJobsForUser("u1", {
      fetchJobs: async () => pages([job({ company_name: "Acme" })]),
      officialDiscovery: runner,
    });

    expect(result.jobs[0]?.applyOptions?.some((option) => option.url === destination)).toBe(true);
    expect(result.jobs[0]?.officialDiscovery?.status).toBe("verified_official_job");
    expect(result.jobs[0]?.applySourceKind).toBe("official_company_site");
  });

  it("still returns usable results when the discovery stage throws", async () => {
    const result = await searchJobsForUser("u1", {
      fetchJobs: async () => pages([job()]),
      officialDiscovery: async () => {
        throw new Error("discovery exploded");
      },
    });

    expect(result.metadata.total).toBe(1);
    expect(result.jobs[0]?.officialDiscovery).toBeUndefined();
    // The original link is still there to act on.
    expect(result.jobs[0]?.googleJobsUrl ?? result.jobs[0]?.applyUrl).toBeDefined();
  });

  it("does not run discovery when the stage is explicitly disabled", async () => {
    const result = await searchJobsForUser("u1", {
      fetchJobs: async () => pages([job()]),
      officialDiscovery: null,
    });

    expect(result.jobs[0]?.officialDiscovery).toBeUndefined();
  });
});

/**
 * Employer-board discovery inside the pipeline.
 *
 * The stage is injected, so no test touches a real board. What is under contract:
 * board postings merge into the ranked result, they deduplicate against search
 * results, and the stage can never break a scan.
 */
describe("searchJobsForUser with employer-board discovery", () => {
  function boardJob(overrides: Partial<NormalizedJob> & { id: string }): NormalizedJob {
    return {
      fingerprint: `fp-${overrides.id}`,
      title: "Backend Engineer",
      company: "Acme",
      source: "Greenhouse",
      isFresh: true,
      isNew: false,
      relevanceScore: 50,
      relevanceReasons: [],
      ...overrides,
    };
  }

  it("merges board postings into the scan and reports the coverage", async () => {
    const result = await searchJobsForUser("u1", {
      fetchJobs: async () => pages([job()]),
      officialDiscovery: null,
      directSources: async () => ({
        jobs: [
          boardJob({
            id: "ats:greenhouse:acme:9",
            location: "Berlin, Germany",
            applyUrl: "https://job-boards.greenhouse.io/acme/jobs/9",
          }),
        ],
        reports: [
          { platform: "greenhouse", tenant: "acme", employer: "Acme", status: "ok", returned: 12, matched: 1 },
        ],
      }),
    });

    expect(result.metadata.total).toBe(2);
    expect(result.metadata.directSourcePostings).toBe(1);
    expect(result.metadata.directSourceBoards).toBe(1);
    expect(result.metadata.directSources?.[0]).toMatchObject({ tenant: "acme", matched: 1 });
  });

  it("collapses a board posting that duplicates a search result", async () => {
    const boardUrl = "https://job-boards.greenhouse.io/acme/jobs/1";
    const fingerprint = buildFingerprint({
      title: "Backend Engineer",
      company: "Acme",
      location: "Berlin, Germany",
      url: boardUrl,
    });

    const result = await searchJobsForUser("u1", {
      fetchJobs: async () =>
        pages([
          job({
            title: "Backend Engineer",
            company_name: "Acme",
            location: "Berlin, Germany",
            apply_options: [{ title: "Greenhouse", link: boardUrl }],
          }),
        ]),
      officialDiscovery: null,
      directSources: async () => ({
        jobs: [
          boardJob({
            id: "ats:greenhouse:acme:1",
            fingerprint,
            location: "Berlin, Germany",
            applyUrl: boardUrl,
            applyOptions: [{ publisher: "Greenhouse", url: boardUrl }],
          }),
        ],
        reports: [],
      }),
    });

    expect(result.metadata.total).toBe(1);
    expect(result.metadata.duplicateCount).toBe(1);
  });

  it("never fails the scan when the stage is disabled or throws", async () => {
    const disabled = await searchJobsForUser("u1", {
      fetchJobs: async () => pages([job()]),
      officialDiscovery: null,
      directSources: null,
    });
    expect(disabled.metadata.total).toBe(1);
    expect(disabled.metadata.directSourcePostings).toBe(0);

    const throwing = await searchJobsForUser("u1", {
      fetchJobs: async () => pages([job()]),
      officialDiscovery: null,
      directSources: async () => {
        throw new Error("board stage exploded");
      },
    });
    expect(throwing.metadata.total).toBe(1);
    expect(throwing.metadata.directSourcePostings).toBe(0);
  });
});
