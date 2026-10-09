import { describe, expect, it } from "vitest";

import {
  buildOfficialQuery,
  discoverOfficialDestination,
  evaluateCandidates,
  locationConflicts,
  looksLikeJobPosting,
  titleMatchesJob,
  type DiscoveryTarget,
  type WebCandidate,
} from "@/lib/jobs/official-careers";

/**
 * Official-careers discovery: deciding whether a search result is the same
 * employer *and* the same role as the listing.
 *
 * The two real failures this pins are the ones the classifier cannot fix on its
 * own, because the wrong link is a genuine ATS posting — just somebody else's:
 *
 * - A Pinterest listing carried `granite.wd1.myworkdayjobs.com` (Granite).
 * - A Home Depot listing carried `blueorigin.wd5.myworkdayjobs.com` (Blue Origin).
 *
 * Discovery must never attach a stranger's posting, however familiar its host,
 * and must never turn "we could not tell" into a claim that the listing is fake.
 */

function target(overrides: Partial<DiscoveryTarget> = {}): DiscoveryTarget {
  return {
    id: "job-1",
    title: "Software Engineer Intern",
    company: "Pinterest",
    location: "Remote",
    ...overrides,
  };
}

const searchReturning =
  (results: readonly WebCandidate[]) =>
  async (): Promise<readonly WebCandidate[]> =>
    results;

describe("discoverOfficialDestination", () => {
  it("verifies the employer's own job page when employer and title match", async () => {
    const outcome = await discoverOfficialDestination(
      target(),
      searchReturning([
        {
          title: "Software Engineer Intern",
          link: "https://www.pinterestcareers.com/jobs/12345/software-engineer-intern",
        },
      ])
    );

    expect(outcome.status).toBe("verified_official_job");
    expect(outcome.destination?.url).toBe(
      "https://www.pinterestcareers.com/jobs/12345/software-engineer-intern"
    );
    expect(outcome.destination?.kind).toBe("official_company_site");
  });

  it("verifies an employer-specific ATS posting when its tenant matches", async () => {
    const outcome = await discoverOfficialDestination(
      target({ company: "Rula", title: "Software Engineer" }),
      searchReturning([
        { title: "Software Engineer", link: "https://jobs.ashbyhq.com/rula/abc-123" },
      ])
    );

    expect(outcome.status).toBe("verified_employer_ats_job");
    expect(outcome.destination?.kind).toBe("verified_employer_ats");
    expect(outcome.destination?.provider).toBe("Ashby");
  });

  it("accepts an equivalent title, not only an identical one", async () => {
    const outcome = await discoverOfficialDestination(
      target({ title: "Software Engineer" }),
      searchReturning([
        { title: "Software Developer - Core Platform", link: "https://www.pinterestcareers.com/jobs/42/software-developer" },
      ])
    );

    // Same role family (software), so it is the same role described differently.
    expect(outcome.status).toBe("verified_official_job");
  });

  it("never attaches a familiar ATS that belongs to another employer (Granite/Pinterest)", async () => {
    const outcome = await discoverOfficialDestination(
      target(),
      searchReturning([
        {
          title: "Software Engineer Intern",
          link: "https://granite.wd1.myworkdayjobs.com/en-US/Granite/jobs/999",
        },
      ])
    );

    expect(outcome.status).toBe("employer_mismatch");
    expect(outcome.destination).toBeUndefined();
    expect(outcome.evidence.join(" ")).toMatch(/different employer/i);
  });

  it("never attaches an unrelated ATS tenant (Home Depot / Blue Origin)", async () => {
    const outcome = await discoverOfficialDestination(
      target({ company: "The Home Depot", title: "Software Engineer Intern" }),
      searchReturning([
        {
          title: "Software Engineer Intern",
          link: "https://blueorigin.wd5.myworkdayjobs.com/en-US/BlueOrigin/jobs/1",
        },
      ])
    );

    expect(outcome.status).toBe("employer_mismatch");
    expect(outcome.destination).toBeUndefined();
  });

  it("does not treat a first-listed job board as the employer's page", async () => {
    const outcome = await discoverOfficialDestination(
      target(),
      searchReturning([
        { title: "Software Engineer Intern", link: "https://www.linkedin.com/jobs/view/999" },
        {
          title: "Software Engineer Intern",
          link: "https://www.pinterestcareers.com/jobs/12345/sw-intern",
        },
      ])
    );

    expect(outcome.status).toBe("verified_official_job");
    expect(outcome.destination?.url).toContain("pinterestcareers.com");
  });

  it("reports a role mismatch when the employer page is a different role", async () => {
    const outcome = await discoverOfficialDestination(
      target(),
      searchReturning([
        { title: "Civil Engineer", link: "https://www.pinterestcareers.com/jobs/9/civil-engineer" },
      ])
    );

    expect(outcome.status).toBe("role_mismatch");
    expect(outcome.destination).toBeUndefined();
  });

  it("reports the employer's site with no matching posting, not a role mismatch", async () => {
    const outcome = await discoverOfficialDestination(
      target(),
      searchReturning([{ title: "Pinterest Careers", link: "https://www.pinterestcareers.com/" }])
    );

    expect(outcome.status).toBe("employer_found_no_job");
    expect(outcome.destination).toBeUndefined();
  });

  it("reports a location conflict for the right role in the wrong country", async () => {
    const outcome = await discoverOfficialDestination(
      target({ location: "Bengaluru, India" }),
      searchReturning([
        {
          title: "Software Engineer Intern",
          link: "https://www.pinterestcareers.com/jobs/12345/sw-intern",
          snippet: "Based in Austin, United States.",
        },
      ])
    );

    expect(outcome.status).toBe("location_mismatch");
    expect(outcome.destination).toBeUndefined();
  });

  it("treats a provider failure as an outcome, never a thrown error", async () => {
    const outcome = await discoverOfficialDestination(target(), async () => {
      throw new Error("rate limited");
    });

    expect(outcome.status).toBe("provider_error");
    expect(outcome.destination).toBeUndefined();
  });

  it("does not search when the listing names no employer", async () => {
    let called = false;
    const outcome = await discoverOfficialDestination(
      target({ company: undefined }),
      async () => {
        called = true;
        return [];
      }
    );

    expect(outcome.status).toBe("no_employer_domain");
    expect(called).toBe(false);
  });

  it("ignores malformed and adversarial result URLs", () => {
    const outcome = evaluateCandidates(target(), [
      { title: "Software Engineer Intern", link: "not a url" },
      { title: "Software Engineer Intern", link: "javascript:alert(1)" },
      { title: "Software Engineer Intern", link: "https://" },
      { link: "https://www.pinterestcareers.com/jobs/1/sw-intern", title: "Software Engineer Intern" },
    ]);

    expect(outcome.status).toBe("verified_official_job");
    expect(outcome.destination?.url).toBe("https://www.pinterestcareers.com/jobs/1/sw-intern");
  });
});

describe("titleMatchesJob", () => {
  it("matches the same role family", () => {
    expect(titleMatchesJob("Software Engineer Intern", "Software Engineer Intern, Core")).toBe(true);
  });

  it("rejects a generic careers page", () => {
    expect(titleMatchesJob("Software Engineer Intern", "Careers at Pinterest")).toBe(false);
    expect(titleMatchesJob("Software Engineer Intern", "")).toBe(false);
  });

  it("rejects a different role family", () => {
    expect(titleMatchesJob("Software Engineer", "Civil Engineer")).toBe(false);
  });
});

describe("looksLikeJobPosting", () => {
  it("rejects career hubs and the bare domain", () => {
    expect(looksLikeJobPosting("https://acme.com/")).toBe(false);
    expect(looksLikeJobPosting("https://www.pinterestcareers.com/")).toBe(false);
    expect(looksLikeJobPosting("https://acme.com/careers")).toBe(false);
    expect(looksLikeJobPosting("https://acme.com/careers/")).toBe(false);
  });

  it("accepts a specific posting path", () => {
    expect(looksLikeJobPosting("https://acme.com/careers/12345/software-engineer")).toBe(true);
    expect(looksLikeJobPosting("https://jobs.ashbyhq.com/rula/abc-123")).toBe(true);
  });

  it("rejects a non-URL", () => {
    expect(looksLikeJobPosting("careers")).toBe(false);
  });
});

describe("buildOfficialQuery", () => {
  it("includes a concrete location", () => {
    const query = buildOfficialQuery(target({ location: "Hyderabad, India" }));
    expect(query).toContain("Pinterest");
    expect(query).toContain("Software Engineer Intern");
    expect(query).toContain("Hyderabad");
  });

  it("drops remote and worldwide phrases", () => {
    expect(buildOfficialQuery(target({ location: "Remote" }))).not.toContain("Remote");
    expect(buildOfficialQuery(target({ location: "Worldwide" }))).not.toContain("Worldwide");
  });

  it("returns null when there is nothing to search on", () => {
    expect(buildOfficialQuery(target({ company: "" }))).toBeNull();
    expect(buildOfficialQuery(target({ title: "" }))).toBeNull();
  });
});

describe("locationConflicts", () => {
  it("flags two different countries", () => {
    expect(locationConflicts("Bengaluru, India", "Austin, United States")).toBe(true);
  });

  it("abstains when a side has no explicit country", () => {
    expect(locationConflicts("Bengaluru, India", "Backend team")).toBe(false);
    expect(locationConflicts(undefined, "Austin, United States")).toBe(false);
  });
});
