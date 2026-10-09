import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JobCard, JobResults } from "@/components/job-results";
import type { JobSearchMetadata, NormalizedJob } from "@/lib/jobs/types";

/**
 * The card's call to action has to match the evidence.
 *
 * A verified destination may say "Apply"; an unclassified one may only offer
 * "View original listing". The tests render the real component so this stays a
 * property of the UI, not just of the classifier.
 */

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    id: overrides.id ?? "job",
    fingerprint: "fp",
    title: "Software Engineer",
    company: "Acme",
    source: "Google Jobs",
    isFresh: true,
    isNew: false,
    relevanceScore: 60,
    relevanceReasons: [],
    ...overrides,
  };
}

function render(j: NormalizedJob): string {
  return renderToStaticMarkup(
    createElement(JobCard, { job: j, applied: false, onToggleApplied: () => undefined })
  );
}

describe("JobCard call to action", () => {
  it("offers Apply for an official company page", () => {
    const html = render(job({ applyUrl: "https://acme.com/jobs/1", applyUrlPublisher: "Acme" }));
    expect(html).toContain("Official company careers");
    expect(html).toContain('href="https://acme.com/jobs/1"');
    expect(html).toContain("Apply to Software Engineer");
    expect(html).toContain(">Apply");
  });

  it("offers Apply for a verified employer ATS", () => {
    const html = render(
      job({
        company: "Rula",
        applyUrl: "https://jobs.ashbyhq.com/rula/abc",
        applyUrlPublisher: "Ashby",
      })
    );
    expect(html).toContain("Verified employer ATS");
    expect(html).toContain("Apply to Software Engineer");
  });

  it("labels an included third-party listing truthfully but still links it", () => {
    const html = render(
      job({
        applyOptions: [
          { publisher: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1" },
        ],
      })
    );
    expect(html).toContain("Third-party listing");
    expect(html).toContain('href="https://www.linkedin.com/jobs/view/1"');
    // A publisher's page is an honest "View listing", never an application.
    expect(html).toContain("View listing");
    expect(html).not.toContain("Apply to Software Engineer");
  });

  it("names the destination provider on a verified ATS", () => {
    const html = render(
      job({
        company: "Rula",
        applyUrl: "https://jobs.ashbyhq.com/rula/abc",
        applyUrlPublisher: "Rula",
      })
    );
    expect(html).toContain("via Ashby");
  });

  it("explains the source check when discovery ran", () => {
    const html = render(
      job({
        applyUrl: "https://mystery.example/apply/1",
        applyUrlPublisher: "Mystery",
        officialDiscovery: {
          status: "employer_mismatch",
          evidence: [
            "The only employer-specific posting found belongs to a different employer.",
          ],
          resolvedAt: "2026-10-09T12:00:00.000Z",
        },
      })
    );

    expect(html).toContain("Why this source?");
    expect(html).toContain("A matching ATS posting belongs to a different employer.");
    expect(html).toContain("2026-10-09");
  });

  it("only offers the original listing when the destination is unverified", () => {
    const html = render(
      job({ applyUrl: "https://mystery.example/apply/1", applyUrlPublisher: "Mystery" })
    );
    expect(html).toContain("Destination not verified");
    expect(html).toContain("View original listing");
    expect(html).toContain("View the original listing for Software Engineer");
    expect(html).not.toContain("Apply to Software Engineer");
  });

  it("shows no link at all when the listing offered none", () => {
    const html = render(job({}));
    expect(html).toContain("No apply link on this listing");
    expect(html).not.toContain("href=\"http");
  });
});

const metadata: JobSearchMetadata = {
  total: 1,
  freshCount: 1,
  newCount: 0,
  salaryKnownCount: 0,
  belowMinimumCount: 0,
  unknownAgeCount: 0,
  searchedRoles: ["Backend Engineer"],
  searchedLocations: ["Remote"],
  searchCount: 1,
  failedSearchCount: 0,
  rawCount: 1,
  duplicateCount: 0,
  freshnessDays: 14,
  experienceLevel: "entry",
  scannedAt: "2026-10-01T00:00:00.000Z",
  newTrackingAvailable: true,
};

describe("JobResults honest empty state", () => {
  it("says no verified employer-hosted listing was found, and offers to broaden", () => {
    const html = renderToStaticMarkup(
      createElement(JobResults, {
        result: {
          jobs: [
            job({
              applyOptions: [
                { publisher: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1" },
              ],
            }),
          ],
          metadata,
          attempts: [],
        },
      })
    );

    expect(html).toContain("No verified employer-hosted listings were found for this search.");
    expect(html).toContain("Include third-party listings");
    // The hidden listing is not rendered as a card under the default preference.
    expect(html).not.toContain('href="https://www.linkedin.com/jobs/view/1"');
  });
});
