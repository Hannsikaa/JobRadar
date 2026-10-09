import { describe, expect, it } from "vitest";

import { normalizeText, isSectionHeading, splitIntoSections, SECTION_HEADINGS, ALL_SECTION_HEADINGS } from "@/lib/resume/parser/normalization";
import type { ExtractedText } from "@/lib/resume/parser/types";

function makeExtracted(text: string): ExtractedText {
  return {
    text,
    charCount: text.length,
    lineCount: text.split(/\r?\n/).length,
  };
}

describe("normalizeText", () => {
  it("normalizes CRLF line endings to LF", () => {
    const input = makeExtracted("Line 1\r\nLine 2\r\nLine 3");
    const result = normalizeText(input);

    expect(result.text).not.toContain("\r");
    expect(result.text).toBe("Line 1\nLine 2\nLine 3");
  });

  it("normalizes CR line endings to LF", () => {
    const input = makeExtracted("Line 1\rLine 2\rLine 3");
    const result = normalizeText(input);

    expect(result.text).not.toContain("\r");
    expect(result.text).toBe("Line 1\nLine 2\nLine 3");
  });

  it("trims whitespace from each line", () => {
    const input = makeExtracted("  Line 1  \n  Line 2  \n  Line 3  ");
    const result = normalizeText(input);

    expect(result.text).toBe("Line 1\nLine 2\nLine 3");
  });

  it("collapses excessive blank lines to at most two", () => {
    const input = makeExtracted("Line 1\n\n\n\n\nLine 2");
    const result = normalizeText(input);

    expect(result.text).toBe("Line 1\n\n\nLine 2");
  });

  it("preserves up to two consecutive blank lines", () => {
    const input = makeExtracted("Line 1\n\nLine 2");
    const result = normalizeText(input);

    expect(result.text).toBe("Line 1\n\nLine 2");
  });

  it("trims leading and trailing blank lines", () => {
    const input = makeExtracted("\n\nLine 1\nLine 2\n\n");
    const result = normalizeText(input);

    expect(result.text).toBe("Line 1\nLine 2");
  });

  it("preserves original counts in metadata", () => {
    const input = makeExtracted("Line 1\nLine 2");
    const result = normalizeText(input);

    expect(result.originalCharCount).toBe(input.charCount);
    expect(result.originalLineCount).toBe(input.lineCount);
  });

  it("drops extractor page markers", () => {
    const input = makeExtracted("John Doe\n-- 1 of 1 --\nSkills\nPython");
    const result = normalizeText(input);

    expect(result.text).not.toContain("-- 1 of 1 --");
    expect(result.text).toBe("John Doe\nSkills\nPython");
  });

  it("handles empty input", () => {
    const input = makeExtracted("");
    const result = normalizeText(input);

    expect(result.text).toBe("");
    expect(result.originalCharCount).toBe(0);
  });
});

describe("isSectionHeading", () => {
  it("detects exact education headings", () => {
    expect(isSectionHeading("Education")).toEqual({ section: "education", heading: "Education" });
    expect(isSectionHeading("education")).toEqual({ section: "education", heading: "education" });
    expect(isSectionHeading("EDUCATION")).toEqual({ section: "education", heading: "EDUCATION" });
  });

  it("detects education heading variants", () => {
    expect(isSectionHeading("Academic Background")).toEqual({ section: "education", heading: "Academic Background" });
    expect(isSectionHeading("Academic Qualifications")).toEqual({ section: "education", heading: "Academic Qualifications" });
    expect(isSectionHeading("Educational Qualifications")).toEqual({ section: "education", heading: "Educational Qualifications" });
  });

  it("detects headings with trailing colon", () => {
    expect(isSectionHeading("Education:")).toEqual({ section: "education", heading: "Education:" });
    expect(isSectionHeading("Skills:")).toEqual({ section: "skills", heading: "Skills:" });
  });

  it("detects skills headings", () => {
    expect(isSectionHeading("Skills")).toEqual({ section: "skills", heading: "Skills" });
    expect(isSectionHeading("Technical Skills")).toEqual({ section: "skills", heading: "Technical Skills" });
    expect(isSectionHeading("Technical Expertise")).toEqual({ section: "skills", heading: "Technical Expertise" });
  });

  it("detects experience headings", () => {
    expect(isSectionHeading("Experience")).toEqual({ section: "experience", heading: "Experience" });
    expect(isSectionHeading("Work Experience")).toEqual({ section: "experience", heading: "Work Experience" });
    expect(isSectionHeading("Professional Experience")).toEqual({ section: "experience", heading: "Professional Experience" });
  });

  it("detects projects headings", () => {
    expect(isSectionHeading("Projects")).toEqual({ section: "projects", heading: "Projects" });
    expect(isSectionHeading("Personal Projects")).toEqual({ section: "projects", heading: "Personal Projects" });
  });

  it("detects certifications headings", () => {
    expect(isSectionHeading("Certifications")).toEqual({ section: "certifications", heading: "Certifications" });
    expect(isSectionHeading("Certificates")).toEqual({ section: "certifications", heading: "Certificates" });
  });

  it("returns null for empty lines", () => {
    expect(isSectionHeading("")).toBeNull();
    expect(isSectionHeading("   ")).toBeNull();
  });

  it("returns null for lines that are too long", () => {
    const longLine = "This is a very long line that looks like a sentence rather than a heading because it has many words and ends with a period.";
    expect(isSectionHeading(longLine)).toBeNull();
  });

  it("returns null for sentences ending with period", () => {
    expect(isSectionHeading("This is a sentence.")).toBeNull();
    expect(isSectionHeading("I worked at Google.")).toBeNull();
  });

  it("returns null for non-heading lines", () => {
    expect(isSectionHeading("Python, Java, TypeScript")).toBeNull();
    expect(isSectionHeading("Bachelor of Science")).toBeNull();
    expect(isSectionHeading("Software Engineer at Google")).toBeNull();
  });
});

describe("splitIntoSections", () => {
  it("splits text into sections based on headings", () => {
    const input = makeExtracted([
      "John Doe",
      "Software Engineer",
      "",
      "Education",
      "Bachelor of Science in Computer Science",
      "Stanford University",
      "2020 - 2024",
      "",
      "Experience",
      "Software Engineer at Google",
      "2024 - Present",
      "",
      "Skills",
      "Python, TypeScript, React",
    ].join("\n"));

    const sections = splitIntoSections(input);

    expect(sections.has("header")).toBe(true);
    expect(sections.has("education")).toBe(true);
    expect(sections.has("experience")).toBe(true);
    expect(sections.has("skills")).toBe(true);

    expect(sections.get("header")).toContain("John Doe");
    expect(sections.get("header")).toContain("Software Engineer");
    expect(sections.get("education")).toContain("Bachelor of Science in Computer Science");
    expect(sections.get("education")).toContain("Stanford University");
    expect(sections.get("experience")).toContain("Software Engineer at Google");
    expect(sections.get("skills")).toContain("Python, TypeScript, React");
  });

  it("does not include heading lines in section content", () => {
    const input = makeExtracted("Education\nBachelor of Science");
    const sections = splitIntoSections(input);

    expect(sections.get("education")).not.toContain("Education");
    expect(sections.get("education")).toContain("Bachelor of Science");
  });

  it("handles sections in different order", () => {
    const input = makeExtracted([
      "Experience",
      "Software Engineer at Google",
      "",
      "Education",
      "Bachelor of Science",
    ].join("\n"));

    const sections = splitIntoSections(input);

    const experienceLines = sections.get("experience") ?? [];
    const educationLines = sections.get("education") ?? [];

    expect(experienceLines).toContain("Software Engineer at Google");
    expect(educationLines).toContain("Bachelor of Science");
  });

  it("handles missing sections", () => {
    const input = makeExtracted("John Doe\nSoftware Engineer");
    const sections = splitIntoSections(input);

    expect(sections.has("header")).toBe(true);
    expect(sections.get("header")).toContain("John Doe");
    expect(sections.get("education")).toEqual([]);
  });

  it("handles multiple sections of the same type", () => {
    const input = makeExtracted([
      "Education",
      "Bachelor of Science",
      "",
      "Education",
      "Master of Science",
    ].join("\n"));

    const sections = splitIntoSections(input);

    expect(sections.get("education")).toContain("Bachelor of Science");
    expect(sections.get("education")).toContain("Master of Science");
  });
});

describe("SECTION_HEADINGS", () => {
  it("contains all expected section categories", () => {
    expect(SECTION_HEADINGS).toHaveProperty("education");
    expect(SECTION_HEADINGS).toHaveProperty("skills");
    expect(SECTION_HEADINGS).toHaveProperty("experience");
    expect(SECTION_HEADINGS).toHaveProperty("projects");
    expect(SECTION_HEADINGS).toHaveProperty("certifications");
  });

  it("has at least one heading per category", () => {
    for (const headings of Object.values(SECTION_HEADINGS)) {
      expect(headings.length).toBeGreaterThan(0);
    }
  });
});

describe("ALL_SECTION_HEADINGS", () => {
  it("contains all headings flattened", () => {
    const expectedCount = Object.values(SECTION_HEADINGS).reduce((sum, arr) => sum + arr.length, 0);
    expect(ALL_SECTION_HEADINGS.length).toBe(expectedCount);
  });
});