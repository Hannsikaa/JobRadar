import { describe, expect, it } from "vitest";

import {
  SOURCE_LABELS,
  classifyDestination,
  hostOf,
  selectJobSource,
  unwrapRedirect,
} from "@/lib/jobs/apply-source";
import type { ApplyOption, NormalizedJob } from "@/lib/jobs/types";

/**
 * Destination classification and apply-link selection.
 *
 * These tests pin the corrected evidence model, and the two real failures that
 * motivated it:
 *
 * - Pinterest carried a `granite.wd1.myworkdayjobs.com` option (Granite
 *   Construction). A familiar ATS must not outrank the employer's own page.
 * - Khan Academy's only link was `remote-work.app`, an unlisted republisher. An
 *   unknown host must never be promoted to a verified official application.
 */

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    id: "serpapi:1",
    fingerprint: "fp-1",
    title: "Software Engineer",
    source: "Google Jobs",
    isFresh: true,
    isNew: false,
    relevanceScore: 50,
    relevanceReasons: [],
    ...overrides,
  };
}

function options(...entries: [string, string][]): ApplyOption[] {
  return entries.map(([publisher, url]) => ({ publisher, url }));
}

describe("hostOf", () => {
  it("lowercases and strips a leading www", () => {
    expect(hostOf("https://WWW.Greenhouse.IO/jobs/1")).toBe("greenhouse.io");
  });

  it("returns null for an unusable URL", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf("javascript:alert(1)")).toBeNull();
  });
});

describe("unwrapRedirect", () => {
  it("follows a redirect query parameter", () => {
    const wrapped =
      "https://tracker.example/r?url=https%3A%2F%2Fcareers.snowflake.com%2Fjobs%2F1";
    expect(unwrapRedirect(wrapped)).toBe("https://careers.snowflake.com/jobs/1");
  });

  it("leaves a plain URL untouched", () => {
    const plain = "https://careers.snowflake.com/jobs/1?utm_source=x";
    expect(unwrapRedirect(plain)).toBe(plain);
  });
});

describe("classifyDestination", () => {
  it("calls the employer's own domain official", () => {
    const result = classifyDestination("https://careers.snowflake.com/jobs/1", "Snowflake");
    expect(result.kind).toBe("official_company_site");
    expect(result.official).toBe(true);
    expect(result.label).toBe(SOURCE_LABELS.official_company_site);
  });

  it("matches a brand label with a careers suffix", () => {
    expect(
      classifyDestination("https://www.pinterestcareers.com/jobs/1", "Pinterest").kind
    ).toBe("official_company_site");
  });

  it("verifies an ATS only when the tenant matches the employer", () => {
    expect(
      classifyDestination("https://boards.greenhouse.io/acme/jobs/1", "Acme").kind
    ).toBe("verified_employer_ats");
    expect(classifyDestination("https://acme.myworkdayjobs.com/jobs/1", "Acme").kind).toBe(
      "verified_employer_ats"
    );
  });

  it("calls another employer's ATS board a third party", () => {
    const workday = classifyDestination(
      "https://granite.wd1.myworkdayjobs.com/en-US/careers/job/XMLNAME-2027-Summer-Engineer-Intern_R0000008259",
      "Pinterest"
    );
    expect(workday.kind).toBe("third_party");
    expect(workday.official).toBe(false);
  });

  it("treats an ATS with no employer named as unverified, not third-party", () => {
    expect(classifyDestination("https://boards.greenhouse.io/acme/jobs/1", undefined).kind).toBe(
      "unverified"
    );
  });

  it("calls a known aggregator a third party", () => {
    expect(classifyDestination("https://remote-work.app/khan-academy", "Khan Academy").kind).toBe(
      "third_party"
    );
    expect(classifyDestination("https://www.linkedin.com/jobs/view/1", "Acme").kind).toBe(
      "third_party"
    );
  });

  it("calls a university repost a third party", () => {
    expect(classifyDestination("https://careers.example.edu/jobs/1", "Acme").kind).toBe(
      "third_party"
    );
  });

  it("never promotes a known board to official just because its brand is the company", () => {
    expect(
      classifyDestination("https://www.hiringmirror.com/jobs/junior-backend", "HiringMirror").kind
    ).toBe("third_party");
    expect(
      classifyDestination("https://naukrimitra.in/job/remote-ai-engineer", "Naukri Mitra").kind
    ).toBe("third_party");
  });

  it("never treats a lookalike domain as the employer", () => {
    expect(classifyDestination("https://pineapple.com/jobs/1", "Apple").kind).toBe("unverified");
    expect(classifyDestination("https://applebees.com/jobs/1", "Apple").kind).toBe("unverified");
    expect(classifyDestination("https://acme.meta.example.com/jobs/1", "Meta").kind).toBe(
      "unverified"
    );
  });

  it("does not verify an opaque shortener", () => {
    expect(classifyDestination("https://bit.ly/3xYz", "Acme").kind).toBe("unverified");
  });

  it("verifies through a legitimate redirect wrapper", () => {
    const wrapped =
      "https://tracker.example/r?url=https%3A%2F%2Fcareers.snowflake.com%2Fjobs%2F1";
    expect(classifyDestination(wrapped, "Snowflake").kind).toBe("official_company_site");
  });

  it("marks a malformed URL unverified instead of throwing", () => {
    expect(classifyDestination("not a url", "Acme").kind).toBe("unverified");
  });

  it("adds a title-consistency note only when the URL names a conflicting role", () => {
    const mismatch = classifyDestination(
      "https://acme.myworkdayjobs.com/en-US/job/Civil-Engineer_R1",
      "Acme",
      "Software Engineer Intern"
    );
    expect(mismatch.kind).toBe("verified_employer_ats");
    expect(mismatch.evidence.join(" ")).toContain("Civil Engineer");
  });
});

describe("selectJobSource", () => {
  it("prefers the employer's own page over a familiar ATS (Pinterest regression)", () => {
    const pinterest = job({
      company: "Pinterest",
      title: "Software Engineer Intern 2027 (USA)",
      applyOptions: options(
        ["Pinterest Careers", "https://www.pinterestcareers.com/jobs/7838577/software-engineer-intern-2027-usa/"],
        [
          "Workday",
          "https://granite.wd1.myworkdayjobs.com/en-US/careers/job/XMLNAME-2027-Summer-Engineer-Intern_R0000008259",
        ],
        ["University of X", "https://careers.example.edu/jobs/42"]
      ),
    });

    const source = selectJobSource(pinterest);
    expect(source?.kind).toBe("official_company_site");
    expect(source?.official).toBe(true);
    expect(source?.url.startsWith("https://www.pinterestcareers.com/")).toBe(true);
  });

  it("never verifies a Khan Academy repost on an unknown republisher (regression)", () => {
    const khan = job({
      company: "Khan Academy",
      title: "Software Engineer Intern (Summer 2027)",
      applyOptions: options(["Remote-Work.app", "https://remote-work.app/khan-academy-intern"]),
    });

    const source = selectJobSource(khan);
    expect(source?.kind).toBe("third_party");
    expect(source?.official).toBe(false);
  });

  it("picks the highest trust tier regardless of option order", () => {
    const chosen = selectJobSource(
      job({
        company: "Acme",
        applyOptions: options(
          ["Aggregator", "https://www.linkedin.com/jobs/view/1"],
          ["Greenhouse", "https://boards.greenhouse.io/acme/jobs/1"],
          ["Acme", "https://acme.com/careers/1"]
        ),
      })
    );
    expect(chosen?.kind).toBe("official_company_site");
  });

  it("keeps the listing order when candidates tie", () => {
    const chosen = selectJobSource(
      job({
        company: "Acme",
        applyOptions: options(
          ["First", "https://www.linkedin.com/jobs/view/1"],
          ["Second", "https://jooble.org/job/2"]
        ),
      })
    );
    expect(chosen?.publisher).toBe("First");
  });

  it("falls back to the Google listing when no apply link exists", () => {
    const source = selectJobSource(
      job({ company: "Acme", googleJobsUrl: "https://google.com/jobs/abc" })
    );
    expect(source?.kind).toBe("unverified");
    expect(source?.url).toBe("https://google.com/jobs/abc");
  });

  it("returns null when the listing offers no link at all", () => {
    expect(selectJobSource(job({ company: "Acme" }))).toBeNull();
  });

  it("uses the normalized applyUrl when applyOptions is absent", () => {
    const source = selectJobSource(
      job({
        company: "Acme",
        applyUrl: "https://boards.greenhouse.io/acme/jobs/9",
        applyUrlPublisher: "Greenhouse",
      })
    );
    expect(source?.kind).toBe("verified_employer_ats");
  });
});
