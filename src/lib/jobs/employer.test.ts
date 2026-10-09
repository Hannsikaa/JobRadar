import { describe, expect, it } from "vitest";

import {
  distinctiveEmployerTokens,
  employerMatchesHost,
  employerSlug,
  employerTokens,
  tenantMatchesEmployer,
  titlesAreConsistent,
} from "@/lib/jobs/employer";

/**
 * Employer identity matching.
 *
 * The cases that matter are the near-misses: a domain that merely contains the
 * employer's name, an ATS tenant that belongs to somebody else, and titles that
 * look similar but describe different jobs.
 */

describe("employerTokens / employerSlug", () => {
  it("drops legal suffixes and connector words", () => {
    expect(employerTokens("Acme, Inc.")).toEqual(["acme"]);
    expect(employerTokens("The Walt Disney Company")).toEqual(["walt", "disney"]);
    expect(employerSlug("ABOUT YOU")).toBe("aboutyou");
  });

  it("keeps multi-word slugs joined", () => {
    expect(employerSlug("Munich Re")).toBe("munichre");
    expect(employerSlug("Blue Origin")).toBe("blueorigin");
  });

  it("keeps only long identity words as distinctive tokens", () => {
    expect(distinctiveEmployerTokens("Khan Academy")).toEqual(["khan", "academy"]);
    expect(distinctiveEmployerTokens("Munich Re")).toEqual(["munich"]);
  });
});

describe("employerMatchesHost", () => {
  it("matches the employer's own domain", () => {
    expect(employerMatchesHost("pinterest.com", "Pinterest")).toBe(true);
    expect(employerMatchesHost("careers.snowflake.com", "Snowflake")).toBe(true);
    expect(employerMatchesHost("jobs.pwc.de", "PwC")).toBe(true);
    expect(employerMatchesHost("hire.munichre.com", "Munich Re")).toBe(true);
    expect(employerMatchesHost("corporate.aboutyou.de", "ABOUT YOU")).toBe(true);
  });

  it("matches a brand label with a recognised brand word attached", () => {
    expect(employerMatchesHost("pinterestcareers.com", "Pinterest")).toBe(true);
    expect(employerMatchesHost("jobs.ebayinc.com", "eBay")).toBe(true);
    expect(employerMatchesHost("disneycareers.com", "The Walt Disney Company")).toBe(true);
  });

  it("refuses a domain that merely contains the employer name", () => {
    expect(employerMatchesHost("pineapple.com", "Apple")).toBe(false);
    expect(employerMatchesHost("applebees.com", "Apple")).toBe(false);
    expect(employerMatchesHost("notmeta.example", "Meta")).toBe(false);
  });

  it("only trusts the registrable brand label, not an arbitrary subdomain", () => {
    expect(employerMatchesHost("meta.example.com", "Meta")).toBe(false);
    expect(employerMatchesHost("careers.meta.com", "Meta")).toBe(true);
    expect(employerMatchesHost("bob.blogspot.com", "Bob")).toBe(false);
  });

  it("does not match an unrelated host", () => {
    expect(employerMatchesHost("granite.wd1.myworkdayjobs.com", "Pinterest")).toBe(false);
    expect(employerMatchesHost("remote-work.app", "Khan Academy")).toBe(false);
  });
});

describe("tenantMatchesEmployer", () => {
  it("matches an ATS tenant equal to the employer", () => {
    expect(tenantMatchesEmployer("acme", "Acme")).toBe(true);
    expect(tenantMatchesEmployer("blueorigin", "Blue Origin")).toBe(true);
    expect(tenantMatchesEmployer("salesforce", "Salesforce")).toBe(true);
  });

  it("matches a tenant that is one identity token of a longer name", () => {
    expect(tenantMatchesEmployer("granite", "Granite Construction")).toBe(true);
  });

  it("refuses a tenant that belongs to a different employer", () => {
    expect(tenantMatchesEmployer("granite", "Pinterest")).toBe(false);
    expect(tenantMatchesEmployer("meta", "Metabase")).toBe(false);
  });
});

describe("titlesAreConsistent", () => {
  it("accepts compatible titles", () => {
    expect(titlesAreConsistent("Software Engineer Intern", "Software Engineer Intern 2027")).toBe(
      true
    );
    expect(titlesAreConsistent("SWE Intern", "Software Engineer Intern")).toBe(true);
  });

  it("flags material contradictions", () => {
    expect(titlesAreConsistent("Software Engineer Intern", "Civil Engineer")).toBe(false);
    expect(titlesAreConsistent("Backend Developer", "Construction Project Manager")).toBe(false);
  });

  it("does not false-negative on empty input", () => {
    expect(titlesAreConsistent("", "Anything")).toBe(true);
  });
});
