import { describe, expect, it } from "vitest";

import {
  DEFAULT_JOB_FILTERS,
  applyJobControls,
  countActiveFilters,
  defaultJobFilters,
  filterJobs,
  filterJobsBySource,
  getWorkMode,
  jobSourceKind,
  salarySortValue,
  sortJobs,
  type JobFilters,
} from "@/lib/jobs/filter";
import type { NormalizedJob } from "@/lib/jobs/types";

/**
 * Result filtering and sorting.
 *
 * The tests are written around the two rules the module promises: unknown is
 * never treated as a value, and a missing salary never sorts as if it were zero.
 */

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    id: overrides.id ?? overrides.title ?? "job",
    fingerprint: "fp",
    title: "Job",
    company: "Acme",
    source: "Google Jobs",
    isFresh: true,
    isNew: false,
    relevanceScore: 50,
    relevanceReasons: [],
    // A default official destination keeps fixtures realistic under the default
    // "official & verified" source preference. Source tests override this.
    applyUrl: "https://acme.com/jobs/1",
    applyUrlPublisher: "Acme",
    ...overrides,
  };
}

function filters(overrides: Partial<JobFilters> = {}): JobFilters {
  return { ...DEFAULT_JOB_FILTERS, ...overrides };
}

describe("getWorkMode", () => {
  it("reads an explicit isRemote true as remote", () => {
    expect(getWorkMode(job({ isRemote: true }))).toBe("remote");
  });

  it("reads remote from the location text", () => {
    expect(getWorkMode(job({ location: "Remote — United States" }))).toBe("remote");
    expect(getWorkMode(job({ location: "Work from home" }))).toBe("remote");
  });

  it("prefers hybrid when the listing says hybrid", () => {
    expect(getWorkMode(job({ isRemote: true, location: "Austin, TX (Hybrid)" }))).toBe("hybrid");
  });

  it("reads an explicit isRemote false as on-site", () => {
    expect(getWorkMode(job({ isRemote: false }))).toBe("onsite");
  });

  it("leaves an unlabelled city unknown rather than calling it on-site", () => {
    expect(getWorkMode(job({ location: "New York, NY" }))).toBe("unknown");
    expect(getWorkMode(job({}))).toBe("unknown");
  });
});

describe("filterJobs", () => {
  it("filters by application status", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const applied = new Set(["b"]);

    expect(filterJobs(jobs, filters({ status: "applied" }), applied).map((j) => j.id)).toEqual(["b"]);
    expect(
      filterJobs(jobs, filters({ status: "not-applied" }), applied).map((j) => j.id)
    ).toEqual(["a"]);
  });

  it("excludes an unknown posted age from a day window", () => {
    const jobs = [
      job({ id: "today", posted: { days: 0, text: "Today" } }),
      job({ id: "old", posted: { days: 20, text: "20 days ago" } }),
      job({ id: "unknown" }),
    ];

    expect(filterJobs(jobs, filters({ posted: 3 })).map((j) => j.id)).toEqual(["today"]);
  });

  it("keeps jobs inside the posted window", () => {
    const jobs = [
      job({ id: "two", posted: { days: 2, text: "2 days ago" } }),
      job({ id: "eight", posted: { days: 8, text: "8 days ago" } }),
    ];

    expect(filterJobs(jobs, filters({ posted: 7 })).map((j) => j.id)).toEqual(["two"]);
  });

  it("filters by whether a salary is listed", () => {
    const jobs = [
      job({ id: "with", salary: { text: "$100,000 a year", min: 100000 } }),
      job({ id: "without" }),
    ];

    expect(filterJobs(jobs, filters({ salary: "with" })).map((j) => j.id)).toEqual(["with"]);
    expect(filterJobs(jobs, filters({ salary: "without" })).map((j) => j.id)).toEqual(["without"]);
  });

  it("does not match unknown work mode against a specific mode", () => {
    const jobs = [
      job({ id: "remote", isRemote: true }),
      job({ id: "city", location: "New York, NY" }),
    ];

    expect(filterJobs(jobs, filters({ workMode: "remote" })).map((j) => j.id)).toEqual(["remote"]);
    expect(filterJobs(jobs, filters({ workMode: "onsite" }))).toHaveLength(0);
  });

  it("filters by minimum score inclusively", () => {
    const jobs = [
      job({ id: "low", relevanceScore: 59 }),
      job({ id: "edge", relevanceScore: 60 }),
      job({ id: "high", relevanceScore: 95 }),
    ];

    expect(filterJobs(jobs, filters({ minScore: 60 })).map((j) => j.id)).toEqual(["edge", "high"]);
  });

  it("combines filters conjunctively", () => {
    const jobs = [
      job({ id: "keep", relevanceScore: 90, isRemote: true, salary: { text: "$1", min: 1 } }),
      job({ id: "low", relevanceScore: 40, isRemote: true, salary: { text: "$1", min: 1 } }),
    ];

    expect(
      filterJobs(jobs, filters({ minScore: 80, workMode: "remote", salary: "with" })).map(
        (j) => j.id
      )
    ).toEqual(["keep"]);
  });
});

describe("source filtering", () => {
  const jobs = [
    job({ id: "official", company: "Acme", applyUrl: "https://acme.com/jobs/1" }),
    job({
      id: "ats",
      company: "Acme",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
      applyUrlPublisher: "Greenhouse",
    }),
    job({
      id: "board",
      company: "Acme",
      applyUrl: "https://www.linkedin.com/jobs/view/1",
      applyUrlPublisher: "LinkedIn",
    }),
    job({
      id: "unknown",
      company: "Acme",
      applyUrl: "https://mystery.example/apply",
      applyUrlPublisher: "Mystery",
    }),
  ];

  it("keeps official and verified-ATS jobs under the default preference", () => {
    expect(filterJobs(jobs, filters({ source: "official" })).map((j) => j.id)).toEqual([
      "official",
      "ats",
    ]);
  });

  it("adds known third-party boards when allowed", () => {
    expect(filterJobs(jobs, filters({ source: "third-party" })).map((j) => j.id)).toEqual([
      "official",
      "ats",
      "board",
    ]);
  });

  it("adds unclassified destinations only under all sources", () => {
    expect(filterJobs(jobs, filters({ source: "all" })).map((j) => j.id)).toEqual([
      "official",
      "ats",
      "board",
      "unknown",
    ]);
  });

  it("never shows an unverified repost in the default view (Khan regression)", () => {
    const khan = job({
      id: "khan",
      company: "Khan Academy",
      title: "Software Engineer Intern (Summer 2027)",
      applyOptions: [
        { publisher: "Remote-Work.app", url: "https://remote-work.app/khan-academy" },
      ],
    });

    expect(filterJobs([khan], filters({ source: "official" }))).toHaveLength(0);
    expect(filterJobs([khan], filters({ source: "third-party" })).map((j) => j.id)).toEqual([
      "khan",
    ]);
    expect(jobSourceKind(khan)).toBe("third_party");
  });

  it("reports the count the preference keeps, before other filters", () => {
    expect(filterJobsBySource(jobs, "official").map((j) => j.id)).toEqual(["official", "ats"]);
    expect(filterJobsBySource(jobs, "third-party")).toHaveLength(3);
  });

  it("classifies a job with no link as unverified", () => {
    expect(jobSourceKind(job({ id: "bare", company: "Acme", applyUrl: undefined }))).toBe(
      "unverified"
    );
  });

  it("does not count the source preference as an active filter", () => {
    expect(countActiveFilters(filters({ source: "all" }))).toBe(0);
  });
});

describe("countActiveFilters", () => {
  it("counts only non-default filters", () => {
    expect(countActiveFilters(DEFAULT_JOB_FILTERS)).toBe(0);
    expect(countActiveFilters(filters({ posted: 7, minScore: 70 }))).toBe(2);
  });
});

describe("defaultJobFilters", () => {
  it("returns a fresh copy so a caller cannot mutate the shared default", () => {
    const copy = defaultJobFilters();
    copy.minScore = 80;
    expect(DEFAULT_JOB_FILTERS.minScore).toBe("all");
  });
});

describe("salarySortValue", () => {
  it("annualizes a known period", () => {
    expect(salarySortValue(job({ salary: { text: "$50 an hour", min: 50, period: "hour" } }))).toBe(
      104000
    );
  });

  it("falls back to the raw number when no period is known", () => {
    expect(salarySortValue(job({ salary: { text: "From $60,000", min: 60000 } }))).toBe(60000);
  });

  it("is null when there is no salary at all", () => {
    expect(salarySortValue(job({}))).toBeNull();
  });
});

describe("sortJobs", () => {
  const jobs = [
    job({ id: "a", title: "A", relevanceScore: 50, posted: { days: 5, text: "5 days ago" } }),
    job({ id: "b", title: "B", relevanceScore: 90, posted: { days: 1, text: "1 day ago" } }),
    job({ id: "c", title: "C", relevanceScore: 70 }),
  ];

  it("defaults to best match", () => {
    expect(sortJobs(jobs, "best").map((j) => j.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts newest first and puts unknown age last", () => {
    expect(sortJobs(jobs, "newest").map((j) => j.id)).toEqual(["b", "a", "c"]);
  });

  it("never mutates the input array", () => {
    const input = [...jobs];
    sortJobs(input, "salary");
    expect(input.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts known salaries first, unknown last, never as zero", () => {
    const paid = [
      job({ id: "low", title: "Low", salary: { text: "$40,000 a year", min: 40000, period: "year" } }),
      job({ id: "none", title: "None" }),
      job({ id: "high", title: "High", salary: { text: "$120,000 a year", min: 120000, period: "year" } }),
    ];

    expect(sortJobs(paid, "salary").map((j) => j.id)).toEqual(["high", "low", "none"]);
  });

  it("breaks salary ties by score", () => {
    const tied = [
      job({ id: "lo", relevanceScore: 10, salary: { text: "$100,000", min: 100000, period: "year" } }),
      job({ id: "hi", relevanceScore: 80, salary: { text: "$100,000", min: 100000, period: "year" } }),
    ];

    expect(sortJobs(tied, "salary").map((j) => j.id)).toEqual(["hi", "lo"]);
  });
});

describe("applyJobControls", () => {
  it("filters and sorts together", () => {
    const jobs = [
      job({ id: "a", relevanceScore: 90, isRemote: true }),
      job({ id: "b", relevanceScore: 95, location: "New York, NY" }),
    ];

    expect(applyJobControls(jobs, filters({ workMode: "remote" }), "best").map((j) => j.id)).toEqual(
      ["a"]
    );
  });
});
