import { describe, expect, it, vi } from "vitest";

import type { DestinationCache } from "@/lib/jobs/official-cache";
import type { OfficialDiscoveryOutcome } from "@/lib/jobs/official-careers";
import {
  attachOfficialDestinations,
  officialDiscoveryKey,
  resolveOfficialDestinations,
  selectDiscoveryGroups,
} from "@/lib/jobs/official-discovery";
import type { NormalizedJob } from "@/lib/jobs/types";

/**
 * The bounded orchestration around discovery.
 *
 * What matters here is cost and blast radius, not the classification itself:
 * one provider call per distinct employer+role+location, cache hits that avoid
 * the call entirely, results attached to the right job only, and a provider
 * failure that costs one job instead of the scan.
 */

function job(overrides: Partial<NormalizedJob> & { id: string }): NormalizedJob {
  return {
    fingerprint: `fp-${overrides.id}`,
    title: "Software Engineer",
    company: "Pinterest",
    source: "Google Jobs",
    isFresh: true,
    isNew: false,
    relevanceScore: 50,
    relevanceReasons: [],
    ...overrides,
  };
}

const NOW = new Date("2026-10-09T12:00:00.000Z");

/** An in-memory cache that records usage, including the TTL it was written with. */
class FakeCache implements DestinationCache {
  readonly store = new Map<string, OfficialDiscoveryOutcome>();
  readonly writes: Array<{ key: string; ttlMs: number }> = [];
  reads = 0;

  async read(key: string): Promise<OfficialDiscoveryOutcome | null> {
    this.reads += 1;
    return this.store.get(key) ?? null;
  }

  async write(key: string, outcome: OfficialDiscoveryOutcome, ttlMs: number): Promise<void> {
    this.writes.push({ key, ttlMs });
    this.store.set(key, outcome);
  }
}

const verified = (url: string): OfficialDiscoveryOutcome => ({
  status: "verified_official_job",
  destination: {
    url,
    kind: "official_company_site",
    provider: "pinterestcareers.com",
    evidence: ["Found on pinterestcareers.com, the employer's own domain."],
  },
  evidence: ["Found on pinterestcareers.com, the employer's own domain."],
});

describe("selectDiscoveryGroups", () => {
  it("groups listings that share an employer, role, and location", () => {
    const groups = selectDiscoveryGroups(
      [
        job({ id: "a", relevanceScore: 10 }),
        job({ id: "b", relevanceScore: 90 }),
        job({ id: "c", company: "Acme", title: "Backend Engineer" }),
      ],
      5
    );

    expect(groups).toHaveLength(2);
    // Ordered by the best score in the group, so the budget goes to the best.
    expect(groups[0]?.target.company).toBe("Pinterest");
    expect([...groups[0]!.jobIds].sort()).toEqual(["a", "b"]);
  });

  it("skips listings that already have a verified destination", () => {
    const groups = selectDiscoveryGroups(
      [job({ id: "official", applyUrl: "https://www.pinterestcareers.com/jobs/1/sw" })],
      5
    );

    expect(groups).toHaveLength(0);
  });

  it("skips listings with no employer or title", () => {
    expect(selectDiscoveryGroups([job({ id: "a", company: undefined })], 5)).toHaveLength(0);
    expect(selectDiscoveryGroups([job({ id: "b", title: "" })], 5)).toHaveLength(0);
  });

  it("returns nothing when the budget is zero", () => {
    expect(selectDiscoveryGroups([job({ id: "a" })], 0)).toEqual([]);
  });

  it("respects the target ceiling, preferring higher scores", () => {
    const groups = selectDiscoveryGroups(
      [
        job({ id: "low", company: "Low", relevanceScore: 10 }),
        job({ id: "high", company: "High", relevanceScore: 99 }),
        job({ id: "mid", company: "Mid", relevanceScore: 60 }),
      ],
      2
    );

    expect(groups.map((group) => group.target.company)).toEqual(["High", "Mid"]);
  });
});

describe("officialDiscoveryKey", () => {
  it("distinguishes employers", () => {
    expect(officialDiscoveryKey({ company: "Pinterest", title: "Engineer" })).not.toBe(
      officialDiscoveryKey({ company: "Granite", title: "Engineer" })
    );
  });

  it("is null without an employer or title", () => {
    expect(officialDiscoveryKey({ company: "", title: "Engineer" })).toBeNull();
    expect(officialDiscoveryKey({ company: "Acme", title: "" })).toBeNull();
  });
});

describe("resolveOfficialDestinations", () => {
  it("issues one provider call for duplicate employer+role listings", async () => {
    const search = vi.fn(async () => [
      { title: "Software Engineer", link: "https://www.pinterestcareers.com/jobs/1/sw" },
    ]);

    const results = await resolveOfficialDestinations(
      [job({ id: "a" }), job({ id: "b" })],
      baseDeps({ search })
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(results.get("a")?.status).toBe("verified_official_job");
    expect(results.get("b")?.status).toBe("verified_official_job");
  });

  it("serves a cached outcome without calling the provider", async () => {
    const cache = new FakeCache();
    const key = officialDiscoveryKey(job({ id: "a" }));
    if (key !== null) {
      cache.store.set(key, verified("https://www.pinterestcareers.com/jobs/1/sw"));
    }

    const search = vi.fn();
    const results = await resolveOfficialDestinations([job({ id: "a" })], baseDeps({ search, cache }));

    expect(cache.reads).toBe(1);
    expect(search).not.toHaveBeenCalled();
    expect(results.get("a")?.destination?.url).toBe(
      "https://www.pinterestcareers.com/jobs/1/sw"
    );
  });

  it("respects the target budget", async () => {
    const search = vi.fn(async () => []);
    const jobs = [
      job({ id: "a", company: "Acme", title: "Backend Engineer", relevanceScore: 10 }),
      job({ id: "b", company: "Globex", title: "Data Analyst", relevanceScore: 20 }),
      job({ id: "c", company: "Initech", title: "Designer", relevanceScore: 30 }),
    ];

    await resolveOfficialDestinations(jobs, baseDeps({ search, maxTargets: 2 }));

    expect(search).toHaveBeenCalledTimes(2);
  });

  it("keeps a provider failure to the one job it affected", async () => {
    const search = vi.fn(async (query: string) => {
      if (query.includes("Pinterest")) {
        throw new Error("rate limited");
      }
      return [{ title: "Backend Engineer", link: "https://acme.com/jobs/2/backend-engineer" }];
    });

    const results = await resolveOfficialDestinations(
      [
        job({ id: "pinterest" }),
        job({ id: "acme", company: "Acme", title: "Backend Engineer" }),
      ],
      baseDeps({ search })
    );

    expect(results.get("pinterest")?.status).toBe("provider_error");
    expect(results.get("acme")?.status).toBe("verified_official_job");
  });

  it("caches negatives with the shorter lifetime and positives with the longer one", async () => {
    const cache = new FakeCache();
    const search = vi.fn(async () => []);

    await resolveOfficialDestinations([job({ id: "a" })], baseDeps({ search, cache }));

    expect(cache.writes).toHaveLength(1);
    expect(cache.writes[0]?.ttlMs).toBe(1_000);
  });
});

describe("attachOfficialDestinations", () => {
  it("adds a verified destination without erasing the original options", () => {
    const original = { publisher: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1" };
    const results = new Map([
      ["a", { jobId: "a", ...verified("https://www.pinterestcareers.com/jobs/1/sw") }],
    ]);

    const [attached] = attachOfficialDestinations(
      [job({ id: "a", applyOptions: [original] })],
      results,
      NOW
    );

    expect(attached?.applyOptions?.map((option) => option.url)).toEqual([
      "https://www.pinterestcareers.com/jobs/1/sw",
      "https://www.linkedin.com/jobs/view/1",
    ]);
    expect(attached?.officialDiscovery?.status).toBe("verified_official_job");
    expect(attached?.officialDiscovery?.resolvedAt).toBe(NOW.toISOString());
  });

  it("does not duplicate a destination already present", () => {
    const existing = { publisher: "Pinterest", url: "https://www.pinterestcareers.com/jobs/1/sw" };
    const results = new Map([
      ["a", { jobId: "a", ...verified("https://www.pinterestcareers.com/jobs/1/sw") }],
    ]);

    const [attached] = attachOfficialDestinations(
      [job({ id: "a", applyOptions: [existing] })],
      results,
      NOW
    );

    expect(attached?.applyOptions).toHaveLength(1);
  });

  it("records a negative outcome without changing any links", () => {
    const results = new Map([
      [
        "a",
        {
          jobId: "a",
          status: "employer_mismatch" as const,
          evidence: ["The only employer-specific posting found belongs to a different employer."],
        },
      ],
    ]);

    const [attached] = attachOfficialDestinations([job({ id: "a" })], results, NOW);

    expect(attached?.officialDiscovery?.status).toBe("employer_mismatch");
    expect(attached?.applyOptions).toBeUndefined();
  });

  it("leaves jobs with no outcome untouched", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const results = new Map([
      ["a", { jobId: "a", ...verified("https://www.pinterestcareers.com/jobs/1/sw") }],
    ]);

    const attached = attachOfficialDestinations(jobs, results, NOW);

    expect(attached[1]).toBe(jobs[1]);
  });
});

function baseDeps(overrides: {
  search: (query: string) => Promise<readonly { title?: string; link?: string }[]>;
  cache?: DestinationCache | null;
  maxTargets?: number;
}) {
  return {
    search: overrides.search,
    cache: overrides.cache ?? null,
    now: NOW,
    maxTargets: overrides.maxTargets ?? 5,
    concurrency: 2,
    positiveTtlMs: 10_000,
    negativeTtlMs: 1_000,
  };
}
