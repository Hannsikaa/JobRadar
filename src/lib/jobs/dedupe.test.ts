import { describe, expect, it } from "vitest";

import { selectJobSource } from "@/lib/jobs/apply-source";
import { completenessScore, dedupeJobs } from "@/lib/jobs/dedupe";
import type { NormalizedJob } from "@/lib/jobs/types";

/**
 * Deduplication.
 *
 * Beyond collapsing repeats, the case that matters here is the same vacancy
 * reaching us through several publishers: one copy carries the employer's own
 * page and another only an aggregator. The merged record must keep both links so
 * the verified destination can win the apply selection.
 */

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    id: "serpapi:1",
    fingerprint: "fp-1",
    title: "Software Engineer",
    company: "Acme",
    source: "Google Jobs",
    isFresh: true,
    isNew: false,
    relevanceScore: 50,
    relevanceReasons: [],
    ...overrides,
  };
}

describe("dedupeJobs", () => {
  it("merges two entries that share a job id", () => {
    const result = dedupeJobs([
      job({ id: "serpapi:1", fingerprint: "fp-a", description: "Full description" }),
      job({ id: "serpapi:1", fingerprint: "fp-b" }),
    ]);

    expect(result.jobs).toHaveLength(1);
    expect(result.removed).toBe(1);
    expect(result.jobs[0]?.description).toBe("Full description");
  });

  it("merges two entries that share a fingerprint", () => {
    const result = dedupeJobs([
      job({ id: "serpapi:1", fingerprint: "same" }),
      job({ id: "serpapi:2", fingerprint: "same" }),
    ]);

    expect(result.jobs).toHaveLength(1);
  });

  it("keeps genuinely different jobs apart", () => {
    const result = dedupeJobs([
      job({ id: "serpapi:1", fingerprint: "fp-1" }),
      job({ id: "serpapi:2", fingerprint: "fp-2", title: "Data Scientist" }),
    ]);

    expect(result.jobs).toHaveLength(2);
    expect(result.removed).toBe(0);
  });

  it("unions apply links across publishers of one vacancy (Test E)", () => {
    const result = dedupeJobs([
      job({
        id: "serpapi:9",
        fingerprint: "fp-9",
        applyOptions: [{ publisher: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1" }],
      }),
      job({
        id: "serpapi:9",
        fingerprint: "fp-9",
        applyOptions: [{ publisher: "Acme", url: "https://acme.com/jobs/1" }],
      }),
    ]);

    expect(result.jobs).toHaveLength(1);
    const merged = result.jobs[0];
    expect(merged?.applyOptions?.map((option) => option.url).sort()).toEqual([
      "https://acme.com/jobs/1",
      "https://www.linkedin.com/jobs/view/1",
    ]);
    expect(selectJobSource(merged!)?.kind).toBe("official_company_site");
  });

  it("scores a more complete listing higher", () => {
    const bare = job({ id: "a", fingerprint: "a" });
    const rich = job({
      id: "b",
      fingerprint: "b",
      description: "d",
      salary: { text: "$1" },
      posted: { days: 1, text: "1 day ago" },
      applyUrl: "https://acme.com/jobs/1",
    });

    expect(completenessScore(rich)).toBeGreaterThan(completenessScore(bare));
  });
});
