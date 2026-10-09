/**
 * Text normalization for extracted resume content.
 *
 * Performs safe, conservative normalization that preserves the original
 * meaning and structure while cleaning up common extraction artifacts.
 * Does NOT rewrite, correct, or infer content.
 */

import type { ExtractedText, NormalizedText } from "@/lib/resume/parser/types";

/** Common section heading patterns (case-insensitive). */
export const SECTION_HEADINGS = {
  education: [
    "education",
    "academic background",
    "academic qualifications",
    "educational qualifications",
    "academic history",
    "academic details",
    "education details",
    "educational background",
    "educational details",
    "academics",
  ],
  skills: [
    "skills",
    "technical skills",
    "skills & technologies",
    "skills and technologies",
    "technical expertise",
    "core skills",
    "competencies",
    "technologies",
    "tech stack",
  ],
  experience: [
    "experience",
    "work experience",
    "professional experience",
    "employment",
    "internships",
    "work history",
    "career history",
    "professional background",
    "employment history",
    "internship experience",
    "relevant experience",
    "industry experience",
    "work experience & internships",
    "work experience and internships",
  ],
  projects: [
    "projects",
    "academic projects",
    "personal projects",
    "selected projects",
    "technical projects",
    "key projects",
    "notable projects",
    "major projects",
    "minor projects",
    "software projects",
    "course projects",
    "projects undertaken",
  ],
  certifications: [
    "certifications",
    "certificates",
    "professional certifications",
    "licenses & certifications",
    "licenses and certifications",
    "credentials",
    "certifications and training",
    "certifications & training",
    "training and certifications",
    "courses and certifications",
    "licenses",
  ],
  /**
   * Headings that are real section breaks but carry no data Job Radar stores.
   *
   * They still have to be recognized: if they are not, the text under them is
   * absorbed into whichever extractable section came before (almost always
   * Skills), so awards, languages, and hobbies leak in as bogus skills. Content
   * assigned to this section is intentionally ignored downstream.
   */
  ignored: [
    "summary",
    "professional summary",
    "profile",
    "about",
    "about me",
    "objective",
    "contact",
    "contact information",
    "personal information",
    "personal details",
    "achievements",
    "achievements & awards",
    "achievements and awards",
    "awards",
    "awards & honors",
    "awards and honors",
    "honors",
    "honours",
    "accomplishments",
    "highlights",
    "key highlights",
    "leadership",
    "leadership & activities",
    "leadership and activities",
    "activities",
    "activity",
    "extra-curricular",
    "extracurricular",
    "extracurricular activities",
    "extra curricular",
    "extra curricular activities",
    "extra-curricular activities",
    "co-curricular",
    "co curricular",
    "co-curricular activities",
    "co curricular activities",
    "positions of responsibility",
    "position of responsibility",
    "roles and responsibilities",
    "responsibilities",
    "responsibility",
    "por",
    "hackathon",
    "hackathons",
    "competitions",
    "competitions & awards",
    "competitions and awards",
    "academic achievements",
    "academic awards",
    "technical activities",
    "areas of interest",
    "area of interest",
    "fields of interest",
    "field of interest",
    "research interests",
    "social work",
    "social service",
    "social activities",
    "community service",
    "community involvement",
    "committees",
    "clubs",
    "organizations",
    "organizations & clubs",
    "student organizations",
    "memberships",
    "affiliations",
    "participation",
    "involvement",
    "sports",
    "athletics",
    "strengths",
    "weaknesses",
    "declaration",
    "declarations",
    "miscellaneous",
    "other information",
    "other details",
    "volunteering",
    "volunteer experience",
    "volunteer work",
    "interests",
    "hobbies",
    "languages",
    "publications",
    "publications & presentations",
    "presentations",
    "patents",
    "coursework",
    "courses",
    "training",
    "professional development",
    "workshops",
    "conferences",
    "references",
    "additional information",
    "additional details",
  ],
} as const;

/** All known section heading variants, flattened for detection. */
export const ALL_SECTION_HEADINGS: readonly string[] = Object.values(SECTION_HEADINGS).flat();

/** Page markers an extractor can inject between pages, such as `-- 1 of 1 --`. */
const PAGE_MARKER_PATTERN = /^--\s*\d+\s+of\s+\d+\s*--$/;

/**
 * Normalizes extracted text for structured parsing.
 *
 * Safe operations only:
 * - Normalize line endings (CRLF -> LF)
 * - Remove excessive repeated blank lines (max 2 consecutive)
 * - Trim leading/trailing whitespace from the whole text
 * - Trim leading/trailing whitespace from each line
 * - Preserve meaningful line boundaries
 * - Preserve punctuation
 *
 * Does NOT:
 * - Correct grammar
 * - Rewrite wording
 * - Infer missing facts
 * - Hallucinate sections
 * - Merge unrelated lines
 * - Use an LLM for cleanup
 */
export function normalizeText(extracted: ExtractedText): NormalizedText {
  const { text, charCount, lineCount } = extracted;

  // Normalize line endings to LF
  let normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Split into lines, trim each line, and drop extractor-injected page markers
  // (e.g. "-- 1 of 1 --"). They carry no resume content and would otherwise be
  // parsed as skills or section entries further down the pipeline.
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !PAGE_MARKER_PATTERN.test(line));

  // Remove excessive blank lines (keep max 2 consecutive)
  const dedupedLines: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    if (line.length === 0) {
      blankCount += 1;
      if (blankCount <= 2) {
        dedupedLines.push("");
      }
    } else {
      blankCount = 0;
      dedupedLines.push(line);
    }
  }

  // Trim leading/trailing blank lines
  while (dedupedLines.length > 0 && dedupedLines[0].length === 0) {
    dedupedLines.shift();
  }
  while (dedupedLines.length > 0 && dedupedLines[dedupedLines.length - 1].length === 0) {
    dedupedLines.pop();
  }

  normalized = dedupedLines.join("\n");

  return {
    text: normalized,
    originalCharCount: charCount,
    originalLineCount: lineCount,
  };
}

/**
 * Checks if a line looks like a section heading.
 *
 * A section heading is a line that matches one of the known heading
 * variants (case-insensitive), possibly with trailing punctuation like
 * a colon. It should be relatively short and not look like a sentence.
 *
 * Returns:
 * - { section, heading } for known headings
 * - { section: "unknown", heading } for lines that look like headings but aren't recognized
 * - null for lines that don't look like headings
 */
export function isSectionHeading(line: string): { section: string; heading: string } | null {
  const trimmed = line.trim();
  const trimmedLower = trimmed.toLowerCase();

  // Skip empty lines
  if (trimmed.length === 0) {
    return null;
  }

  // Skip lines that are too long to be headings (likely sentences)
  if (trimmed.length > 60) {
    return null;
  }

  // Skip lines that look like sentences (end with period, have multiple clauses)
  if (trimmedLower.endsWith(".") && trimmedLower.split(" ").length > 4) {
    return null;
  }

  // Check against known headings
  for (const [section, headings] of Object.entries(SECTION_HEADINGS)) {
    for (const heading of headings) {
      const headingLower = heading.toLowerCase();
      // Match exact heading or heading with trailing colon
      if (trimmedLower === headingLower || trimmedLower === `${headingLower}:`) {
        return { section, heading: trimmed };
      }
    }
  }

  // If it looks like a heading (short, no period, title-case or uppercase, 1-2 words) but isn't recognized,
  // treat it as an unknown section so it gets its own bucket and a warning.
  const original = line.trim();
  const wordCount = original.split(/\s+/).length;
  const isShort = wordCount <= 2;
  const isTitleCase = /^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/.test(original);
  const isUpperCase = original === original.toUpperCase() && original.length > 1;
  // Exclude pure numbers (years, etc.) from being treated as headings
  const isPureNumber = /^\d+$/.test(original);
  // Only treat as unknown heading if it contains section-indicating keywords
  const hasSectionKeyword = /\b(section|summary|objective|profile|references?|bibliography|appendix|acknowledgments?)\b/i.test(original);
  if (isShort && (isTitleCase || isUpperCase) && !isPureNumber && hasSectionKeyword) {
    return { section: "unknown", heading: original };
  }

  return null;
}

/**
 * Splits normalized text into sections based on detected headings.
 *
 * Returns a map of section name to the lines belonging to that section.
 * Lines before the first known heading go into a "header" section.
 * Unknown headings (title-case lines not in the known list) create
 * new sections so they can be warned about, but only AFTER a known
 * heading has been encountered.
 * All known sections are pre-initialized with empty arrays.
 */
export function splitIntoSections(normalized: NormalizedText): Map<string, string[]> {
  const sections = new Map<string, string[]>();

  // Pre-initialize all known sections with empty arrays
  const knownSections = ["header", "education", "skills", "experience", "projects", "certifications"];
  for (const section of knownSections) {
    sections.set(section, []);
  }

  let currentSection = "header";
  let hasSeenKnownHeading = false;

  const lines = normalized.text.split("\n");

  for (const line of lines) {
    const headingMatch = isSectionHeading(line);
    if (headingMatch) {
      const isKnownHeading = headingMatch.section !== "unknown";

      if (isKnownHeading) {
        hasSeenKnownHeading = true;
      }

      // Only create a new section for unknown headings if we've seen a known heading
      if (isKnownHeading || (headingMatch.section === "unknown" && hasSeenKnownHeading)) {
        currentSection = headingMatch.section;
        if (!sections.has(currentSection)) {
          sections.set(currentSection, []);
        }
        // Don't include the heading line itself in the content
        continue;
      }
      // If it's an unknown heading but we haven't seen a known heading yet,
      // treat it as regular content in the header
    }

    const sectionLines = sections.get(currentSection) ?? [];
    sectionLines.push(line);
    sections.set(currentSection, sectionLines);
  }

  return sections;
}

// Re-export types for consumers
export type { NormalizedText };