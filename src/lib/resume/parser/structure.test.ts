import { describe, expect, it } from "vitest";

import { parseResumeStructure } from "@/lib/resume/parser/structure";
import { normalizeText } from "@/lib/resume/parser/normalization";
import type { ExtractedText } from "@/lib/resume/parser/types";

function makeExtracted(text: string): ExtractedText {
  return {
    text,
    charCount: text.length,
    lineCount: text.split(/\r?\n/).length,
  };
}

function makeNormalized(text: string) {
  return normalizeText(makeExtracted(text));
}

describe("parseResumeStructure", () => {
  it("extracts name from header", () => {
    const input = makeNormalized("John Doe\nSoftware Engineer\n\nEducation\nBachelor of Science");
    const result = parseResumeStructure(input);

    expect(result.profile.name).toBe("John Doe");
  });

  it("returns empty name when header has no clear name", () => {
    const input = makeNormalized("Education\nBachelor of Science");
    const result = parseResumeStructure(input);

    expect(result.profile.name).toBe("");
    expect(result.warnings).toContain("Could not confidently extract a name from the resume header.");
  });

  it("skips email as name", () => {
    const input = makeNormalized("john.doe@example.com\nSoftware Engineer\n\nEducation\nBachelor of Science");
    const result = parseResumeStructure(input);

    expect(result.profile.name).toBe("Software Engineer");
  });

  it("skips phone as name", () => {
    const input = makeNormalized("+1-555-123-4567\nJohn Doe\n\nEducation\nBachelor of Science");
    const result = parseResumeStructure(input);

    expect(result.profile.name).toBe("John Doe");
  });

  it("skips URL as name", () => {
    const input = makeNormalized("https://linkedin.com/in/johndoe\nJohn Doe\n\nEducation\nBachelor of Science");
    const result = parseResumeStructure(input);

    expect(result.profile.name).toBe("John Doe");
  });

  it("skips section heading as name", () => {
    const input = makeNormalized("Education\nBachelor of Science");
    const result = parseResumeStructure(input);

    expect(result.profile.name).toBe("");
  });

  it("extracts skills from comma-separated list", () => {
    const input = makeNormalized("John Doe\n\nSkills\nPython, Java, TypeScript, React");
    const result = parseResumeStructure(input);

    expect(result.profile.skills).toContain("Python");
    expect(result.profile.skills).toContain("Java");
    expect(result.profile.skills).toContain("TypeScript");
    expect(result.profile.skills).toContain("React");
  });

  it("extracts skills from line-separated list", () => {
    const input = makeNormalized("John Doe\n\nSkills\nPython\nJava\nTypeScript");
    const result = parseResumeStructure(input);

    expect(result.profile.skills).toContain("Python");
    expect(result.profile.skills).toContain("Java");
    expect(result.profile.skills).toContain("TypeScript");
  });

  it("extracts skills from categorized list", () => {
    const input = makeNormalized("John Doe\n\nSkills\nWeb: React, Next.js\nDatabase: MongoDB, PostgreSQL");
    const result = parseResumeStructure(input);

    expect(result.profile.skills).toContain("React");
    expect(result.profile.skills).toContain("Next.js");
    expect(result.profile.skills).toContain("MongoDB");
    expect(result.profile.skills).toContain("PostgreSQL");
  });

  it("deduplicates skills", () => {
    const input = makeNormalized("John Doe\n\nSkills\nPython, Python, Java");
    const result = parseResumeStructure(input);

    expect(result.profile.skills.filter((s) => s === "Python")).toHaveLength(1);
  });

  it("removes empty skill entries", () => {
    const input = makeNormalized("John Doe\n\nSkills\nPython, , Java");
    const result = parseResumeStructure(input);

    expect(result.profile.skills).not.toContain("");
  });

  it("extracts education with degree and school", () => {
    const input = makeNormalized("John Doe\n\nEducation\nBachelor of Science in Computer Science\nStanford University\n2020 - 2024");
    const result = parseResumeStructure(input);

    expect(result.profile.education).toHaveLength(1);
    expect(result.profile.education[0].degree).toBe("Bachelor of Science in Computer Science");
    expect(result.profile.education[0].school).toBe("Stanford University");
    expect(result.profile.education[0].startYear).toBe(2020);
    expect(result.profile.education[0].endYear).toBe(2024);
  });

  it("extracts education with field of study", () => {
    const input = makeNormalized("John Doe\n\nEducation\nBachelor of Science in Computer Science\nStanford University");
    const result = parseResumeStructure(input);

    expect(result.profile.education[0].fieldOfStudy).toBe("Computer Science");
  });

  it("handles currently studying", () => {
    const input = makeNormalized("John Doe\n\nEducation\nBachelor of Science in Computer Science\nStanford University\n2022 - Present");
    const result = parseResumeStructure(input);

    expect(result.profile.education[0].currentlyStudying).toBe(true);
    expect(result.profile.education[0].endYear).toBeUndefined();
  });

  it("extracts experience with title and company", () => {
    const input = makeNormalized("John Doe\n\nExperience\nSoftware Engineer\nGoogle\n2024 - Present");
    const result = parseResumeStructure(input);

    expect(result.profile.experience).toHaveLength(1);
    expect(result.profile.experience[0].title).toBe("Software Engineer");
    expect(result.profile.experience[0].company).toBe("Google");
    expect(result.profile.experience[0].currentlyWorking).toBe(true);
  });

  it("extracts experience with description", () => {
    const input = makeNormalized("John Doe\n\nExperience\nSoftware Engineer\nGoogle\n2024 - Present\nWorked on search infrastructure");
    const result = parseResumeStructure(input);

    expect(result.profile.experience[0].description).toBe("Worked on search infrastructure");
  });

  it("extracts experience with technologies mentioned in description", () => {
    const input = makeNormalized("John Doe\n\nExperience\nSoftware Engineer\nGoogle\n2024 - Present\nTech Stack: Python, Go, Kubernetes");
    const result = parseResumeStructure(input);

    // Experience entry should not have technologies field (per schema)
    expect(result.profile.experience[0]).not.toHaveProperty("technologies");
    // Technologies in experience description are not currently extracted to skills
    // (skills are only extracted from the Skills section)
  });

  it("extracts projects", () => {
    const input = makeNormalized("John Doe\n\nProjects\nJob Radar\nPersonal Project\nNext.js, TypeScript, MongoDB\nBuilt a personalized job discovery platform");
    const result = parseResumeStructure(input);

    expect(result.profile.projects).toHaveLength(1);
    expect(result.profile.projects[0].name).toBe("Job Radar");
    expect(result.profile.projects[0].description).toBe("Built a personalized job discovery platform");
    expect(result.profile.projects[0].technologies).toContain("Next.js");
    expect(result.profile.projects[0].technologies).toContain("TypeScript");
  });

  it("extracts project URL", () => {
    const input = makeNormalized("John Doe\n\nProjects\nJob Radar\nhttps://github.com/johndoe/job-radar\nNext.js, TypeScript");
    const result = parseResumeStructure(input);

    expect(result.profile.projects[0].link).toBe("https://github.com/johndoe/job-radar");
  });

  it("extracts certifications", () => {
    const input = makeNormalized("John Doe\n\nCertifications\nAWS Certified Cloud Practitioner\nAmazon Web Services\n2024");
    const result = parseResumeStructure(input);

    expect(result.profile.certifications).toHaveLength(1);
    expect(result.profile.certifications[0].name).toBe("AWS Certified Cloud Practitioner");
    expect(result.profile.certifications[0].issuer).toBe("Amazon Web Services");
    expect(result.profile.certifications[0].date).toBe("2024");
  });

  it("extracts certification with credential URL", () => {
    const input = makeNormalized("John Doe\n\nCertifications\nAWS Certified Cloud Practitioner\nAmazon Web Services\n2024\nhttps://aws.amazon.com/verification");
    const result = parseResumeStructure(input);

    expect(result.profile.certifications[0].link).toBe("https://aws.amazon.com/verification");
  });

  it("handles sections in different order", () => {
    const input = makeNormalized([
      "John Doe",
      "",
      "Experience",
      "Software Engineer at Google",
      "2024 - Present",
      "",
      "Education",
      "Bachelor of Science",
      "Stanford University",
      "2020 - 2024",
      "",
      "Skills",
      "Python, TypeScript",
    ].join("\n"));

    const result = parseResumeStructure(input);

    expect(result.profile.name).toBe("John Doe");
    expect(result.profile.experience).toHaveLength(1);
    expect(result.profile.education).toHaveLength(1);
    expect(result.profile.skills).toContain("Python");
  });

  it("handles missing sections gracefully", () => {
    const input = makeNormalized("John Doe\nSoftware Engineer");
    const result = parseResumeStructure(input);

    expect(result.profile.name).toBe("John Doe");
    expect(result.profile.education).toEqual([]);
    expect(result.profile.experience).toEqual([]);
    expect(result.profile.projects).toEqual([]);
    expect(result.profile.certifications).toEqual([]);
    expect(result.profile.skills).toEqual([]);
  });

  it("warns about unrecognized sections", () => {
    const input = makeNormalized("John Doe\n\nUnknown Section\nSome content");
    const result = parseResumeStructure(input);

    expect(result.warnings.some((w) => w.includes("Unrecognized section"))).toBe(true);
  });

  it("returns warnings array", () => {
    const input = makeNormalized("Education\nBachelor of Science");
    const result = parseResumeStructure(input);

    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("extracts single-line experience entries", () => {
    const input = makeNormalized(
      "John Doe\n\nExperience\nSoftware Engineer - Acme Corp - 2022-03 to Present\nBuilt REST APIs in TypeScript.\nJunior Developer - Beta GmbH - 2021-01 to 2022-02\nMaintained React dashboards.",
    );
    const result = parseResumeStructure(input);

    expect(result.profile.experience).toHaveLength(2);
    expect(result.profile.experience[0].title).toBe("Software Engineer");
    expect(result.profile.experience[0].company).toBe("Acme Corp");
    expect(result.profile.experience[0].currentlyWorking).toBe(true);
    expect(result.profile.experience[0].description).toBe("Built REST APIs in TypeScript.");
    expect(result.profile.experience[1].company).toBe("Beta GmbH");
    expect(result.profile.experience[1].startDate).toBe("2021");
    expect(result.profile.experience[1].endDate).toBe("2022");
  });

  it("extracts single-line education entries", () => {
    const input = makeNormalized(
      "John Doe\n\nEducation\nBSc Computer Science - Technical University of Berlin - 2017 to 2021",
    );
    const result = parseResumeStructure(input);

    expect(result.profile.education).toHaveLength(1);
    expect(result.profile.education[0].degree).toBe("BSc Computer Science");
    expect(result.profile.education[0].school).toBe("Technical University of Berlin");
    expect(result.profile.education[0].startYear).toBe(2017);
    expect(result.profile.education[0].endYear).toBe(2021);
  });

  it("extracts single-line certification entries", () => {
    const input = makeNormalized(
      "John Doe\n\nCertifications\nAWS Certified Developer Associate - Amazon - 2023-05",
    );
    const result = parseResumeStructure(input);

    expect(result.profile.certifications).toHaveLength(1);
    expect(result.profile.certifications[0].name).toBe("AWS Certified Developer Associate");
    expect(result.profile.certifications[0].issuer).toBe("Amazon");
    expect(result.profile.certifications[0].date).toBe("2023-05");
  });

  it("extracts single-line project entries", () => {
    const input = makeNormalized(
      "John Doe\n\nProjects\nJob Radar - TypeScript, Next.js - Personal job discovery tool.\nChat Relay - Node.js, WebSocket - Realtime message relay server.",
    );
    const result = parseResumeStructure(input);

    expect(result.profile.projects).toHaveLength(2);
    expect(result.profile.projects[0].name).toBe("Job Radar");
    expect(result.profile.projects[0].technologies).toEqual(["TypeScript", "Next.js"]);
    expect(result.profile.projects[0].description).toBe("Personal job discovery tool.");
    expect(result.profile.projects[1].name).toBe("Chat Relay");
  });

  it("recovers the company from a 'Title at Company' line", () => {
    const input = makeNormalized("John Doe\n\nExperience\nSoftware Engineer at Google\n2024 - Present");
    const result = parseResumeStructure(input);

    expect(result.profile.experience).toHaveLength(1);
    expect(result.profile.experience[0].title).toBe("Software Engineer");
    expect(result.profile.experience[0].company).toBe("Google");
  });

  it("drops entries missing required fields instead of failing the parse", () => {
    const input = makeNormalized(
      "John Doe\n\nExperience\nSoftware Engineer Extraordinaire\n\nCertifications\nCert With No Issuer Or Date",
    );
    const result = parseResumeStructure(input);

    expect(result.profile.experience).toEqual([]);
    expect(result.profile.certifications).toEqual([]);
    expect(result.warnings.some((w) => w.includes("experience"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("certification"))).toBe(true);
  });

  it("never treats a bare date range as an entry", () => {
    const input = makeNormalized("John Doe\n\nExperience\n2020 - 2022");
    const result = parseResumeStructure(input);

    expect(result.profile.experience).toEqual([]);
  });
});