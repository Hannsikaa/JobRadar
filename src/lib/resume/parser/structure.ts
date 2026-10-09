/**
 * Structured resume parsing from normalized text.
 *
 * Converts normalized plain text into the ResumeProfile schema using
 * conservative, deterministic rules. Prefers missing data over fabricated data.
 */

import {
  certificationSchema,
  educationSchema,
  experienceSchema,
  normalizeStringList,
  projectSchema,
} from "@/lib/profile/schemas";
import type { NormalizedText, ParsedResumeProfile, ResumeProfileInput } from "@/lib/resume/parser/types";
import { splitIntoSections, isSectionHeading } from "@/lib/resume/parser/normalization";

/** Patterns that indicate a line is likely a name (not a heading/contact). */
const NAME_EXCLUDE_PATTERNS = [
  /^https?:\/\//i,           // URLs
  /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, // emails
  /^[\d\s\-+()]{7,}$/,       // phone numbers
  /^(resume|cv|curriculum vitae)$/i, // document titles
];

/** Maximum reasonable length for a person's name. */
const MAX_NAME_LENGTH = 80;

/**
 * Attempts to extract a person's name from the header section.
 *
 * Conservative approach:
 * - First non-empty line in header that isn't a heading/contact/URL
 * - Avoids obvious section headings
 * - Avoids emails, phones, URLs
 * - Returns empty string if not confident
 */
export function extractName(headerLines: string[]): string {
  for (const line of headerLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    // Skip if it matches exclusion patterns
    if (NAME_EXCLUDE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      continue;
    }

    // Skip if it's a KNOWN section heading (not unknown headings)
    const headingMatch = isSectionHeading(trimmed);
    if (headingMatch && headingMatch.section !== "unknown") {
      continue;
    }

    // Skip if it looks like a heading (all caps, short, no period)
    if (trimmed === trimmed.toUpperCase() && trimmed.length < 30 && !trimmed.includes(" ")) {
      continue;
    }

    // Reasonable name length
    if (trimmed.length > MAX_NAME_LENGTH) {
      continue;
    }

    // Must contain at least one letter
    if (!/[A-Za-z]/.test(trimmed)) {
      continue;
    }

    return trimmed;
  }

  return "";
}

/**
 * Extracts skills from the skills section.
 *
 * Handles:
 * - Comma-separated: "Python, Java, TypeScript"
 * - Line-separated: one per line
 * - Categorized: "Web: React, Next.js\nDatabase: MongoDB"
 * - Bullet points
 */
export function extractSkills(skillsLines: string[]): string[] {
  const skills: string[] = [];

  for (const line of skillsLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    // Remove bullet markers
    const cleaned = trimmed.replace(/^[\-\*\•\u2022]\s*/, "");

    // Remove category prefixes like "Web:", "Database:", "AI & Automation:",
    // "Cloud & Infrastructure:", etc. The prefix is a short label ending in a
    // colon; ampersands, digits, and +/./- appear in real category names, and
    // restricting to letters previously left "AI & Automation:" glued to the
    // first skill.
    const withoutCategory = cleaned.replace(/^[A-Za-z][A-Za-z0-9\s&+.-]{0,39}:\s*/, "");

    // Split by common delimiters
    const parts = withoutCategory.split(/[,;|]/).map((p) => p.trim());

    for (const part of parts) {
      if (part.length > 0 && part.length < 100) {
        skills.push(part);
      }
    }
  }

  // Normalize: trim, dedupe, remove empty
  return normalizeStringList(skills);
}

/**
 * Extracts education entries from the education section.
 *
 * Looks for patterns like:
 * - Degree + Institution
 * - Degree + Field + Institution
 * - With optional years
 */
export function extractEducation(educationLines: string[]): ResumeProfileInput["education"] {
  const education: NonNullable<ResumeProfileInput["education"]> = [];
  let currentEntry: Partial<NonNullable<ResumeProfileInput["education"]>[0]> = {};

  for (const line of educationLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // A blank line separates paragraphs, not necessarily entries: DOCX/PDF
      // extraction inserts one between every paragraph, so finalizing here
      // would split a single education entry into several. Entries are closed
      // when the next entry starts or at the end of the section instead.
      continue;
    }

    // Single-line entry: "Degree - Institution - Dates".
    const fields = splitDelimitedFields(trimmed);
    if (
      fields !== null &&
      fields.length >= 3 &&
      looksLikeDateField(fields[fields.length - 1]) &&
      looksLikeDegree(fields[0]) &&
      looksLikeInstitution(fields[1])
    ) {
      if (currentEntry.degree || currentEntry.school) {
        if (currentEntry.degree && !currentEntry.fieldOfStudy) {
          currentEntry.fieldOfStudy = extractFieldFromDegree(currentEntry.degree);
        }
        education.push(finalizeEducationEntry(currentEntry));
        currentEntry = {};
      }
      const years = extractYears(fields.slice(2).join(" - "));
      currentEntry = {
        degree: fields[0],
        school: fields[1],
        startYear: years.startYear,
        endYear: years.endYear,
        currentlyStudying: years.currentlyStudying,
      };
      continue;
    }

    // Degree and institution combined on one line, e.g.
    // "Bachelor's Degree in Computer Science and Engineering Kakatiya
    // Institute of Technology and Science, Warangal".
    const combined = splitDegreeAndInstitution(trimmed);
    if (combined) {
      if (currentEntry.degree || currentEntry.school) {
        education.push(finalizeEducationEntry(currentEntry));
        currentEntry = {};
      }
      currentEntry = {
        degree: combined.degree,
        school: combined.school,
      };
      continue;
    }

    // Try to detect degree
    if (!currentEntry.degree && looksLikeDegree(trimmed)) {
      currentEntry.degree = trimmed;
      continue;
    }

    // A second degree line begins a new entry.
    if (currentEntry.degree && currentEntry.school && looksLikeDegree(trimmed)) {
      education.push(finalizeEducationEntry(currentEntry));
      currentEntry = { degree: trimmed };
      continue;
    }

    // Try to detect institution
    if (!currentEntry.school && looksLikeInstitution(trimmed)) {
      currentEntry.school = trimmed;
      continue;
    }

    // Try to detect field of study (standalone line)
    if (!currentEntry.fieldOfStudy && looksLikeFieldOfStudy(trimmed)) {
      currentEntry.fieldOfStudy = trimmed;
      continue;
    }

    // Grade such as "CGPA: 9.03/10" or "GPA - 3.8".
    if (!currentEntry.grade) {
      const grade = extractGrade(trimmed);
      if (grade !== undefined) {
        currentEntry.grade = grade;
        continue;
      }
    }

    // Try to detect years
    const years = extractYears(trimmed);
    if (years.startYear !== undefined && currentEntry.startYear === undefined) {
      currentEntry.startYear = years.startYear;
    }
    if (years.endYear !== undefined && currentEntry.endYear === undefined) {
      currentEntry.endYear = years.endYear;
    }
    // currentlyStudying is set regardless of endYear (it's true for "Present", "Current", etc.)
    if (years.currentlyStudying && currentEntry.currentlyStudying === undefined) {
      currentEntry.currentlyStudying = years.currentlyStudying;
    }
  }

  // Don't forget the last entry
  if (currentEntry.degree || currentEntry.school) {
    education.push(finalizeEducationEntry(currentEntry));
  }

  return education;
}

function finalizeEducationEntry(entry: Partial<NonNullable<ResumeProfileInput["education"]>[0]>): NonNullable<ResumeProfileInput["education"]>[0] {
  const degree = entry.degree ?? "";
  return {
    degree,
    school: entry.school ?? "",
    fieldOfStudy: entry.fieldOfStudy ?? extractFieldFromDegree(degree),
    startYear: entry.startYear,
    endYear: entry.endYear,
    currentlyStudying: entry.currentlyStudying ?? false,
    grade: entry.grade,
  };
}

/** Strong institution nouns used as the split point for "degree institution" lines. */
const STRONG_INSTITUTION_KEYWORDS = [
  "university",
  "college",
  "institute",
  "academy",
  "polytechnic",
  "school",
];

/**
 * Splits a single line that contains both a degree and its institution, such as
 * "Bachelor's Degree in Computer Science and Engineering Kakatiya Institute of
 * Technology and Science, Warangal".
 *
 * Only strong institution nouns are used, so "Bachelor of Technology" is never
 * mistaken for an institution. The word immediately before the institution noun
 * is treated as the start of the institution name ("Kakatiya Institute ...",
 * "Stanford University"). Returns null when no confident split exists.
 */
function splitDegreeAndInstitution(line: string): { degree: string; school: string } | null {
  if (!looksLikeDegree(line)) {
    return null;
  }

  let splitIndex = -1;
  for (const keyword of STRONG_INSTITUTION_KEYWORDS) {
    const match = new RegExp(`\\b${keyword}\\b`, "i").exec(line);
    if (match && match.index > 0 && (splitIndex === -1 || match.index < splitIndex)) {
      splitIndex = match.index;
    }
  }
  if (splitIndex <= 0) {
    return null;
  }

  // Include the proper noun immediately before the institution keyword in the
  // school ("Kakatiya Institute", "Stanford University") rather than leaving it
  // attached to the degree.
  const beforeKeyword = line.slice(0, splitIndex).trimEnd();
  const nameMatch = /([A-Z][\w'&-]*)\s*$/.exec(beforeKeyword);
  let degreeEnd = beforeKeyword.length;
  if (nameMatch && nameMatch.index !== undefined) {
    degreeEnd = nameMatch.index;
  }

  const degree = line.slice(0, degreeEnd).replace(/[\s,;.-]+$/, "").trim();
  const school = line.slice(degreeEnd).trim();
  if (degree.length === 0 || school.length === 0) {
    return null;
  }

  return { degree, school };
}

/** Extracts a grade value from a line such as "CGPA: 9.03/10" or "GPA - 3.8". */
function extractGrade(line: string): string | undefined {
  const match = /^(?:cgpa|gpa|grade|percentage|score)\b\s*[:\-–—]?\s*(.+)$/i.exec(line.trim());
  if (!match) {
    return undefined;
  }
  const value = match[1].trim();
  return value.length > 0 && value.length < 40 ? value : undefined;
}

function looksLikeDegree(line: string): boolean {
  // Word-boundary matching matters: a loose `includes("ma")` would treat
  // "May 2028" as a degree because "May" contains "ma".
  return /\b(?:bachelor|master|phd|ph\.d|doctorate|doctoral|associate|diploma|b\.?s\.?c?|m\.?s\.?c?|b\.?a\b|m\.?b\.?a|b\.?tech|m\.?tech|b\.?e\b|m\.?e\b)\b/i.test(
    line,
  );
}

function looksLikeInstitution(line: string): boolean {
  const institutionKeywords = [
    "university", "college", "institute", "school", "academy",
    "polytechnic", "technology", "technical",
  ];
  const lower = line.toLowerCase();
  // Must contain an institution keyword and be reasonably short
  return institutionKeywords.some((kw) => lower.includes(kw)) && line.length < 100;
}

function looksLikeFieldOfStudy(line: string): boolean {
  // If it contains "in" or "of" and looks like a field description
  const lower = line.toLowerCase();
  return (lower.includes(" in ") || lower.includes(" of ")) && line.length < 100;
}

/**
 * Attempts to extract field of study from a degree line.
 * e.g., "Bachelor of Science in Computer Science" -> "Computer Science"
 * e.g., "B.Tech in Computer Science and Engineering" -> "Computer Science and Engineering"
 */
export function extractFieldFromDegree(degree: string): string | undefined {
  // Find the last occurrence of " in " or " of " and take everything after it
  const inIndex = degree.lastIndexOf(" in ");
  const ofIndex = degree.lastIndexOf(" of ");
  const lastIndex = Math.max(inIndex, ofIndex);
  
  if (lastIndex > 0) {
    const field = degree.substring(lastIndex + 4).trim(); // +4 for " in " or " of "
    // Clean up trailing punctuation
    return field.replace(/[.,;]+$/, "");
  }
  return undefined;
}

function extractYears(line: string): { startYear?: number; endYear?: number; currentlyStudying?: boolean } {
  const presentValues = ["present", "current", "ongoing", "now"];
  const lower = line.toLowerCase();

  // Check for "present" indicators
  const currentlyStudying = presentValues.some((pv) => lower.includes(pv));

  // Look for 4-digit years
  const yearMatches = line.match(/\b(19|20)\d{2}\b/g);
  if (!yearMatches || yearMatches.length === 0) {
    return { currentlyStudying };
  }

  const years = yearMatches.map((y) => parseInt(y, 10)).sort((a, b) => a - b);
  const startYear = years[0];
  const endYear = currentlyStudying ? undefined : (years.length > 1 ? years[years.length - 1] : undefined);

  return { startYear, endYear, currentlyStudying };
}

/**
 * Extracts experience entries from the experience section.
 *
 * Looks for patterns like:
 * - Title + Company
 * - Title + Company + Dates
 * - With optional description and technologies
 */
export function extractExperience(experienceLines: string[]): ResumeProfileInput["experience"] {
  const experience: NonNullable<ResumeProfileInput["experience"]> = [];
  let currentEntry: Partial<NonNullable<ResumeProfileInput["experience"]>[0]> = {};

  for (const line of experienceLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // A blank line separates paragraphs, not entries: extraction inserts one
      // between every DOCX/PDF paragraph, so finalizing here would split a
      // single job into several entries. Entries close when the next header
      // appears or at the end of the section.
      continue;
    }

    // A header on one line: "Title - Company - Dates",
    // "Company (Title) - Dates", or "Title at Company".
    const header = parseExperienceHeader(trimmed);
    if (header) {
      if (currentEntry.title || currentEntry.company) {
        experience.push(finalizeExperienceEntry(currentEntry));
        currentEntry = {};
      }
      currentEntry = { ...header };
      continue;
    }

    if (!currentEntry.title && looksLikeTitle(trimmed) && !looksLikeTechnologies(trimmed)) {
      currentEntry.title = trimmed;
      continue;
    }

    if (!currentEntry.company && looksLikeCompany(trimmed)) {
      currentEntry.company = trimmed;
      continue;
    }

    // Standalone date line, e.g. "2024 - Present".
    if (looksLikeDateField(trimmed) && (currentEntry.startDate === undefined || currentEntry.endDate === undefined)) {
      const dates = extractDateRange(trimmed);
      if (dates.startDate !== undefined && currentEntry.startDate === undefined) {
        currentEntry.startDate = dates.startDate;
      }
      if (dates.endDate !== undefined && currentEntry.endDate === undefined) {
        currentEntry.endDate = dates.endDate;
      }
      if (dates.currentlyWorking && currentEntry.currentlyWorking === undefined) {
        currentEntry.currentlyWorking = dates.currentlyWorking;
      }
      continue;
    }

    // Technology lines are not stored on experience entries.
    if (looksLikeTechnologies(trimmed) && !currentEntry.description) {
      continue;
    }

    // Anything else while an entry is open is that entry's description.
    if (currentEntry.title || currentEntry.company) {
      if (isDescriptionLine(trimmed)) {
        currentEntry.description = mergeDescription(currentEntry.description, trimmed);
      }
      continue;
    }
  }

  // Don't forget the last entry.
  if (currentEntry.title || currentEntry.company) {
    experience.push(finalizeExperienceEntry(currentEntry));
  }

  return experience;
}

/** A month name followed by a year, e.g. "June 2026" or "Jan. 2024". */
const MONTH_YEAR_SOURCE =
  String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}`;

/** A bare four-digit year in a plausible range. */
const YEAR_SOURCE = String.raw`(?:19|20)\d{2}`;

/**
 * Parses a date range such as `June 2026 to September 2026` or `2024 - Present`.
 *
 * Returns the start/end text exactly as written (month preserved) because the
 * profile schema accepts `Jun 2024`, `2024-06`, `2024`, and `Present` shapes.
 */
export function parseDateRange(text: string): { startDate?: string; endDate?: string; currentlyWorking?: boolean } {
  const currentlyWorking = /\b(present|current|ongoing|now)\b/i.test(text);
  const datePattern = new RegExp(`${MONTH_YEAR_SOURCE}|${YEAR_SOURCE}`, "gi");
  const matches = text.match(datePattern);

  if (!matches || matches.length === 0) {
    return { currentlyWorking };
  }

  const startDate = matches[0].replace(/\s+/g, " ").trim();
  const endDate = currentlyWorking
    ? undefined
    : matches.length > 1
      ? matches[matches.length - 1].replace(/\s+/g, " ").trim()
      : undefined;

  return { startDate, endDate, currentlyWorking };
}

/**
 * Splits a trailing date range off a line, returning the leading text.
 *
 * `Craft Connect (Founding Software Developer - Tech Lead) - June 2026- Current`
 * becomes head `Craft Connect (Founding Software Developer - Tech Lead)` with
 * dates parsed from `June 2026- Current`. Returns null when the line does not
 * end in a date range.
 */
function splitTrailingDateRange(
  line: string
): { head: string; dates: { startDate?: string; endDate?: string; currentlyWorking?: boolean } } | null {
  const trimmed = line.trim();
  const rangePattern = new RegExp(
    `(?:${MONTH_YEAR_SOURCE}|${YEAR_SOURCE})(?:\\s*(?:[-–—]|to)\\s*(?:${MONTH_YEAR_SOURCE}|${YEAR_SOURCE}|present|current|now|ongoing))?`,
    "gi"
  );

  // Among every date-like match, only the one that runs to the end of the line
  // is the trailing range; earlier matches (e.g. a year in the company name)
  // are ignored.
  let match: RegExpExecArray | null;
  let chosen: RegExpExecArray | null = null;
  while ((match = rangePattern.exec(trimmed)) !== null) {
    if (trimmed.slice(match.index + match[0].length).trim().length === 0) {
      chosen = match;
    }
  }
  if (!chosen) {
    return null;
  }

  const head = trimmed.slice(0, chosen.index).replace(/[\s\-–—,|]+$/, "").trim();
  if (head.length === 0) {
    return null;
  }

  return { head, dates: parseDateRange(chosen[0]) };
}

/**
 * Parses one-line experience headers, covering the shapes resumes actually use:
 * - `Software Engineer - Google - 2024 - Present`
 * - `Craft Connect (Founding Software Developer) - June 2026 - Current`
 * - `Software Engineer at Google`
 *
 * Returns null for lines that are not a confident header, so description and
 * technology lines keep taking the per-line path.
 */
function parseExperienceHeader(
  line: string
): Partial<NonNullable<ResumeProfileInput["experience"]>[0]> | null {
  const trailing = splitTrailingDateRange(line);

  // "Company (Title)" with a trailing date range.
  if (trailing) {
    const paren = /^(.+?)\s*\((.+)\)$/.exec(trailing.head);
    if (paren) {
      const company = paren[1].trim();
      const title = paren[2].trim();
      if (company.length > 0 && title.length > 0) {
        return { title, company, ...trailing.dates };
      }
    }
  }

  // "Title - Company - Dates".
  const fields = splitDelimitedFields(line);
  if (
    fields !== null &&
    fields.length >= 3 &&
    looksLikeDateField(fields[fields.length - 1]) &&
    (looksLikeTitle(fields[0]) || looksLikeCompany(fields[1]))
  ) {
    return {
      title: fields[0],
      company: fields[1],
      ...extractDateRange(fields.slice(2).join(" - ")),
    };
  }

  // "Title at Company" (optionally followed by a date range).
  const head = trailing ? trailing.head : line.trim();
  const at = /^(.+?)\s+at\s+(.+)$/.exec(head);
  if (at && looksLikeTitle(at[1].trim()) && looksLikeCompany(at[2].trim())) {
    return {
      title: at[1].trim(),
      company: at[2].trim(),
      ...(trailing ? trailing.dates : {}),
    };
  }

  return null;
}

/** Action verbs that begin resume description bullets. */
const DESCRIPTION_VERB_PATTERN =
  /^(?:built|building|develop(?:ed|ing|s)?|design(?:ed|ing|s)?|implement(?:ed|ing|s)?|creat(?:ed|ing|es)|add(?:ed|ing|s)?|migrat(?:ed|ing|es)|improv(?:ed|ing|es)|led|leading|lead|manag(?:ed|ing|es)|wrote|writing|write|automat(?:ed|ing|es)|reduc(?:ed|ing|es)|increas(?:ed|ing|es)|us(?:ed|ing|es)|contribut(?:ed|ing|es)|perform(?:ed|ing|s)?|analy[sz](?:ed|ing|es)|explor(?:ed|ing|es)|integrat(?:ed|ing|es)|maintain(?:ed|ing|s)?|deploy(?:ed|ing|s)?|optimi[sz](?:ed|ing|es)|collaborat(?:ed|ing|es)|help(?:ed|ing|s)?|assist(?:ed|ing|s)?|engineer(?:ed|ing|s)?|architect(?:ed|ing|s)?|deliver(?:ed|ing|s)?|launch(?:ed|ing|es)?|coordinat(?:ed|ing|es)|guid(?:ed|ing|es)|progress(?:ed|ing|es)?|research(?:ed|ing|es)?|exam(?:ined|ining)|identif(?:ied|ying|ies)|establish(?:ed|ing|es)?|achiev(?:ed|ing|es)?|complet(?:ed|ing|es)?|supported|supporting|handled|handling|resolved|resolving|responsible|worked|working)\b/i;

/** Whether a line reads like a description bullet rather than a name or label. */
function isDescriptionLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/[.!?]$/.test(trimmed)) {
    return true;
  }
  if (DESCRIPTION_VERB_PATTERN.test(trimmed)) {
    return true;
  }
  return trimmed.split(/\s+/).length >= 6;
}

/** Joins description lines from one entry into a single string. */
function mergeDescription(existing: string | undefined, line: string): string {
  if (existing === undefined || existing.length === 0) {
    return line;
  }
  return `${existing} ${line}`;
}

function finalizeExperienceEntry(entry: Partial<NonNullable<ResumeProfileInput["experience"]>[0]>): NonNullable<ResumeProfileInput["experience"]>[0] {
  let title = entry.title ?? "";
  let company = entry.company ?? "";

  // A `Software Engineer at Google` line written as one field: split it only
  // when both halves are confidently recognized. Ambiguous lines keep their
  // empty company and are dropped by entry validation rather than guessed at.
  if (company.length === 0) {
    const split = splitTitleAtCompany(title);
    if (split) {
      title = split.title;
      company = split.company;
    }
  }

  return {
    title,
    company,
    location: entry.location,
    description: entry.description,
    startDate: entry.startDate,
    endDate: entry.endDate,
    currentlyWorking: entry.currentlyWorking ?? false,
  };
}

function looksLikeTitle(line: string): boolean {
  const titleKeywords = [
    "engineer", "developer", "programmer", "analyst", "manager", "lead",
    "architect", "designer", "consultant", "intern", "trainee",
    "director", "vp", "cto", "cio", "founder", "co-founder",
    "researcher", "scientist", "specialist", "coordinator",
  ];
  const lower = line.toLowerCase();
  return titleKeywords.some((kw) => lower.includes(kw)) && line.length < 80;
}

function looksLikeCompany(line: string): boolean {
  // Company names often have Inc, LLC, Ltd, Corp, or are proper nouns
  const companyIndicators = [/\b(inc|llc|ltd|corp|corporation|company|co\.)\b/i, /^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/];
  return companyIndicators.some((pattern) => pattern.test(line)) && line.length < 100;
}

function hasDatePattern(line: string): boolean {
  return /\b(19|20)\d{2}\b/.test(line) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i.test(line);
}

/** Spaced delimiters that commonly separate fields on a single-line entry. */
const DELIMITED_FIELD_PATTERN = /\s+(?:[-–—|])\s+/;

/**
 * Splits a single-line entry such as `Title - Company - 2020 - Present` into
 * its fields. Returns null for lines without a spaced delimiter so multi-line
 * resumes keep taking the existing per-line path unchanged.
 */
function splitDelimitedFields(line: string): string[] | null {
  if (!DELIMITED_FIELD_PATTERN.test(line)) {
    return null;
  }

  const fields = line
    .split(DELIMITED_FIELD_PATTERN)
    .map((field) => field.trim())
    .filter((field) => field.length > 0);

  return fields.length >= 2 ? fields : null;
}

/** Whether a line (or field) contains date content such as `2020`, `Jun 2021`, or `Present`. */
function looksLikeDateField(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower === "present" || lower === "current" || lower === "ongoing" || lower === "now") {
    return true;
  }
  return hasDatePattern(text);
}

/** First date-shaped token on a line (`2024`, `2024-05`, `2024-05-18`, `Jun 2024`), if any. */
function extractDateText(line: string): string | null {
  const match =
    /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{4}(?:-\d{2}(?:-\d{2})?)?)\b/i.exec(line);
  return match ? match[1] : null;
}

/**
 * Splits a `Software Engineer at Google` title line into its halves.
 *
 * Returns null unless both halves are confidently recognized, so an ambiguous
 * line keeps its empty company and is dropped by entry validation rather than
 * turned into a guess.
 */
function splitTitleAtCompany(text: string): { title: string; company: string } | null {
  const match = /^(.+?)\s+at\s+(.+)$/.exec(text);
  if (!match) {
    return null;
  }

  const head = match[1].trim();
  const tail = match[2].trim();
  if (!looksLikeTitle(head) || !looksLikeCompany(tail)) {
    return null;
  }

  return { title: head, company: tail };
}

export function extractDateRange(line: string): { startDate?: string; endDate?: string; currentlyWorking?: boolean } {
  const presentValues = ["present", "current", "ongoing", "now"];
  const lower = line.toLowerCase();
  const currentlyWorking = presentValues.some((pv) => lower.includes(pv));

  // Simple extraction - look for date-like patterns
  const datePattern = /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|\d{4})\b/gi;
  const matches = line.match(datePattern);

  if (!matches || matches.length === 0) {
    return { currentlyWorking };
  }

  const startDate = matches[0];
  const endDate = currentlyWorking ? undefined : (matches.length > 1 ? matches[matches.length - 1] : undefined);

  return { startDate, endDate, currentlyWorking };
}

/**
 * Whether a line is a list of technologies rather than prose.
 *
 * A technology line is a short, delimited list of short tokens
 * (`React | TypeScript | MongoDB`), or an explicitly labelled list
 * (`Tech Stack: Python, Go`). The commas-in-any-sentence check this replaced
 * misclassified ordinary description sentences as technology lines.
 */
export function looksLikeTechnologies(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    return false;
  }

  const labelled = /^(?:tech(?:nolog(?:y|ies))?|stack|tools|frameworks|languages|platforms|tech\s+stack)\s*:/i;
  if (labelled.test(trimmed)) {
    return true;
  }

  const parts = trimmed
    .split(/[,;|/·•]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length >= 2 && parts.length <= 12 && parts.every((part) => part.length <= 30);
}

export function extractTechnologies(line: string): string[] {
  // Remove common prefixes (including multi-word ones like "Tech Stack")
  const cleaned = line.replace(/^(tech(?:nolog(?:y|ies))?|stack|tools|frameworks|languages|platforms)(?:\s+stack)?[:]\s*/i, "");
  return normalizeStringList(cleaned.split(/[,;|]/).map((s) => s.trim()));
}

/**
 * Extracts projects from the projects section.
 */
export function extractProjects(projectsLines: string[]): ResumeProfileInput["projects"] {
  const projects: NonNullable<ResumeProfileInput["projects"]> = [];
  let currentEntry: Partial<NonNullable<ResumeProfileInput["projects"]>[0]> = {};

  for (const line of projectsLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // A blank line separates paragraphs, not projects: extraction inserts one
      // between every DOCX/PDF paragraph, so finalizing here would turn each
      // line of a project into its own project. Entries close when the next
      // project name is detected or at the end of the section.
      continue;
    }

    // Single-line entry: "Project Name - Technologies/Link - Description".
    const fields = splitDelimitedFields(trimmed);
    if (
      fields !== null &&
      fields.length >= 2 &&
      !isUrl(fields[0]) &&
      (isUrl(fields[1]) || looksLikeTechnologies(fields[1]))
    ) {
      if (currentEntry.name) {
        projects.push(finalizeProjectEntry(currentEntry));
        currentEntry = {};
      }
      const entry: Partial<NonNullable<ResumeProfileInput["projects"]>[0]> = { name: fields[0] };
      if (isUrl(fields[1])) {
        entry.link = fields[1];
      } else {
        entry.technologies = extractTechnologies(fields[1]);
      }
      if (fields.length > 2) {
        entry.description = fields.slice(2).join(" - ");
      }
      currentEntry = entry;
      continue;
    }

    // First line is the project name.
    if (!currentEntry.name) {
      currentEntry.name = trimmed;
      continue;
    }

    if (!currentEntry.link && isUrl(trimmed)) {
      currentEntry.link = trimmed;
      continue;
    }

    if (looksLikeTechnologies(trimmed)) {
      if (!currentEntry.technologies) {
        currentEntry.technologies = extractTechnologies(trimmed);
      }
      continue;
    }

    // A name-like line starts the next project once the current entry already
    // carries content beyond its name — technologies, a link, or a description.
    // Requiring content beyond the name is what separates a new project name
    // ("Nestham Member Ledger Management System") from a subtitle that sits
    // between the name and the technology line ("Personal Project"). It also
    // means a project that has no description still yields to the next project
    // instead of silently absorbing that project's name and description.
    const hasProjectDetail =
      Boolean(currentEntry.description) ||
      Boolean(currentEntry.link) ||
      (currentEntry.technologies?.length ?? 0) > 0;
    if (hasProjectDetail && looksLikeProjectName(trimmed)) {
      projects.push(finalizeProjectEntry(currentEntry));
      currentEntry = { name: trimmed };
      continue;
    }

    if (isDescriptionLine(trimmed)) {
      currentEntry.description = mergeDescription(currentEntry.description, trimmed);
      continue;
    }
  }

  if (currentEntry.name) {
    projects.push(finalizeProjectEntry(currentEntry));
  }

  return projects;
}

/** Whether a line reads like a project title rather than a sentence. */
function looksLikeProjectName(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    return false;
  }
  if (/[.!?]$/.test(trimmed)) {
    return false;
  }
  if (isUrl(trimmed) || looksLikeTechnologies(trimmed)) {
    return false;
  }
  // Description bullets begin with an action verb; a title does not.
  return !DESCRIPTION_VERB_PATTERN.test(trimmed);
}

function finalizeProjectEntry(entry: Partial<NonNullable<ResumeProfileInput["projects"]>[0]>): NonNullable<ResumeProfileInput["projects"]>[0] {
  return {
    name: entry.name ?? "",
    description: entry.description,
    technologies: entry.technologies ?? [],
    link: entry.link,
    startDate: entry.startDate,
    endDate: entry.endDate,
  };
}

function isUrl(line: string): boolean {
  try {
    new URL(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts certifications from the certifications section.
 */
export function extractCertifications(certLines: string[]): ResumeProfileInput["certifications"] {
  const certifications: NonNullable<ResumeProfileInput["certifications"]> = [];
  let currentEntry: Partial<NonNullable<ResumeProfileInput["certifications"]>[0]> = {};

  for (const line of certLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (currentEntry.name) {
        certifications.push(finalizeCertEntry(currentEntry));
        currentEntry = {};
      }
      continue;
    }

    // Single-line entry: "Name - Issuer - Date".
    const fields = splitDelimitedFields(trimmed);
    if (
      fields !== null &&
      fields.length >= 3 &&
      looksLikeDateField(fields[fields.length - 1]) &&
      !hasDatePattern(fields[1]) &&
      !isUrl(fields[1]) &&
      /^[A-Z0-9]/.test(fields[1])
    ) {
      if (currentEntry.name) {
        certifications.push(finalizeCertEntry(currentEntry));
        currentEntry = {};
      }
      currentEntry = {
        name: fields[0],
        issuer: fields[1],
        date: fields[fields.length - 1],
      };
      continue;
    }

    // First line is likely the certification name
    if (!currentEntry.name) {
      currentEntry.name = trimmed;
      continue;
    }

    // Look for issuer
    if (!currentEntry.issuer && (trimmed.toLowerCase().includes("by ") || looksLikeIssuer(trimmed))) {
      currentEntry.issuer = trimmed.replace(/^by\s+/i, "").trim();
      continue;
    }

    // Look for date: keep only the date-shaped token, never the whole line,
    // so a sentence that merely mentions a year cannot make the entry invalid.
    if (!currentEntry.date && hasDatePattern(trimmed)) {
      const dateText = extractDateText(trimmed);
      if (dateText) {
        currentEntry.date = dateText;
        continue;
      }
    }

    // Look for URL (before credentialId to avoid false matches on "id" in URLs)
    if (!currentEntry.link && isUrl(trimmed)) {
      currentEntry.link = trimmed;
      continue;
    }

    // Look for credential ID
    if (!currentEntry.credentialId && (trimmed.toLowerCase().includes("credential") || trimmed.toLowerCase().includes("id"))) {
      currentEntry.credentialId = trimmed;
      continue;
    }
  }

  if (currentEntry.name) {
    certifications.push(finalizeCertEntry(currentEntry));
  }

  return certifications;
}

function finalizeCertEntry(entry: Partial<NonNullable<ResumeProfileInput["certifications"]>[0]>): NonNullable<ResumeProfileInput["certifications"]>[0] {
  return {
    name: entry.name ?? "",
    issuer: entry.issuer ?? "",
    date: entry.date,
    credentialId: entry.credentialId,
    link: entry.link,
  };
}

function looksLikeIssuer(line: string): boolean {
  const issuerKeywords = ["aws", "amazon", "azure", "google", "microsoft", "oracle", "cisco", "comptia", "pmi", "isc2", "(isc)²"];
  const lower = line.toLowerCase();
  return issuerKeywords.some((kw) => lower.includes(kw));
}

/**
 * Drops section entries that do not satisfy their sub-schema.
 *
 * A single unparseable entry must not fail the whole resume: rejecting a
 * document that is otherwise readable because one line was ambiguous would
 * lose far more than it protects. The dropped entry is reported as a warning
 * so the omission stays visible instead of silent.
 */
function dropInvalidEntries<T>(
  entries: readonly T[] | undefined,
  schema: { safeParse(value: unknown): { success: boolean } },
  label: string,
  warnings: string[],
): T[] {
  const kept: T[] = [];
  for (const entry of entries ?? []) {
    if (schema.safeParse(entry).success) {
      kept.push(entry);
    } else {
      warnings.push(`Skipped an unrecognized ${label} entry that did not match the expected structure.`);
    }
  }
  return kept;
}

/**
 * Main entry point: parses normalized text into a ResumeProfile.
 */
export function parseResumeStructure(normalized: NormalizedText): ParsedResumeProfile {
  const warnings: string[] = [];
  const sections = splitIntoSections(normalized);

  // Extract name from header
  const headerLines = sections.get("header") ?? [];
  const name = extractName(headerLines);
  if (!name) {
    warnings.push("Could not confidently extract a name from the resume header.");
  }

  // Check header for unrecognized section headings
  for (const line of headerLines) {
    const headingMatch = isSectionHeading(line);
    if (headingMatch && headingMatch.section === "unknown") {
      warnings.push(`Unrecognized section: ${headingMatch.heading}`);
    }
  }

  // Extract each section, dropping entries that cannot satisfy their schema so
  // one ambiguous line never fails the whole parse (see dropInvalidEntries).
  const skills = extractSkills(sections.get("skills") ?? []);
  const education = dropInvalidEntries(
    extractEducation(sections.get("education") ?? []),
    educationSchema,
    "education",
    warnings,
  );
  const experience = dropInvalidEntries(
    extractExperience(sections.get("experience") ?? []),
    experienceSchema,
    "experience",
    warnings,
  );
  const projects = dropInvalidEntries(
    extractProjects(sections.get("projects") ?? []),
    projectSchema,
    "project",
    warnings,
  );
  const certifications = dropInvalidEntries(
    extractCertifications(sections.get("certifications") ?? []),
    certificationSchema,
    "certification",
    warnings,
  );

  // Collect any unrecognized sections as warnings
  const knownSections = new Set([
    "header",
    "education",
    "skills",
    "experience",
    "projects",
    "certifications",
    // Recognized as a section break, intentionally not extracted (see
    // SECTION_HEADINGS.ignored). No warning because it is not an oversight.
    "ignored",
  ]);
  for (const [sectionName] of sections) {
    if (!knownSections.has(sectionName)) {
      warnings.push(`Unrecognized section: ${sectionName}`);
    }
  }

  const profile: ResumeProfileInput = {
    name,
    headline: undefined,
    summary: undefined,
    location: undefined,
    skills,
    technologies: [],
    languages: [],
    education,
    experience,
    projects,
    certifications,
  };

  return { profile, warnings };
}

// Re-export types for consumers
export type { ParsedResumeProfile };