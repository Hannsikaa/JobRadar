import { z } from "zod";

/**
 * Validation layer for the profile domain.
 *
 * These schemas are the single source of truth for what a profile may contain.
 * They are deliberately independent of MongoDB: they validate shapes, not
 * storage, so the same rules can be reused by the API layer, by the repository
 * before a write, and by tests.
 *
 * Normalization policy:
 * - Required text is trimmed and must not be empty.
 * - Optional text is trimmed; a value that is present must not be blank
 *   (callers that want "no value" should omit the field entirely).
 * - Optional years/dates may be omitted; nothing is ever invented for a
 *   currently-active entry.
 * - String lists are trimmed, whitespace-only entries are dropped, and exact
 *   duplicates are removed while the first spelling and casing is preserved.
 *   "React" and "react" are treated as distinct values.
 * - Unknown keys are stripped by Zod's default object behaviour, so callers
 *   cannot inject fields (such as storage timestamps) through the API.
 *
 * Parsing these schemas is intentionally shallow: date fields are checked for
 * a recognizable *shape*, not converted into `Date` objects. The profile is
 * user-authored text and the persistence layer stores the normalized strings.
 */

/** Career level of the person the profile belongs to. */
export const EXPERIENCE_LEVELS = [
  "internship",
  "entry",
  "junior",
  "mid",
  "senior",
] as const;

/** How many days a matched job posting is allowed to be old. */
export const FRESHNESS_DAY_OPTIONS = [1, 3, 7, 14] as const;

/** Employment types the person is open to. */
export const JOB_TYPES = [
  "full-time",
  "part-time",
  "contract",
  "internship",
  "freelance",
] as const;

/** Lower bound for calendar years. Rejects typos such as `200`. */
const MIN_YEAR = 1900;

/** Upper bound for calendar years. Leaves room for far-future dates. */
const MAX_YEAR = 2999;

const PRESENT_VALUES = new Set(["present", "current", "ongoing", "now"]);

const ISO_YEAR = /^\d{4}$/;
const ISO_YEAR_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const ISO_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MONTH_YEAR = /^[A-Za-z]{3,9}\.?\s+\d{4}$/;

/** UUID, matching the identifier that resume uploads generate. */
const RESUME_FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape check for a free-text date such as `2024`, `2024-06`, `2024-06-15`,
 * `Jun 2024`, or `Present`. This is not a parser: the value is stored as the
 * normalized string the user typed.
 */
function isDateText(value: string): boolean {
  if (PRESENT_VALUES.has(value.toLowerCase())) {
    return true;
  }

  return (
    ISO_YEAR.test(value) ||
    ISO_YEAR_MONTH.test(value) ||
    ISO_DATE.test(value) ||
    MONTH_YEAR.test(value)
  );
}

/** Required, trimmed, non-empty text. */
const requiredText = (label: string) =>
  z.string().trim().min(1, `${label} must not be empty`);

/** Optional text: omitted is allowed, but a provided value must be real. */
const optionalText = (label: string) =>
  requiredText(label).optional();

/** Optional date text, checked for a recognizable shape. */
const optionalDateText = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} must not be empty`)
    .refine(isDateText, {
      message: `${label} must look like 2024, 2024-06, 2024-06-15, Jun 2024, or Present`,
    })
    .optional();

/** Optional year, bounded to a plausible calendar range. */
const optionalYear = (label: string) =>
  z
    .number()
    .int(`${label} must be a whole number`)
    .min(MIN_YEAR, `${label} must be ${MIN_YEAR} or later`)
    .max(MAX_YEAR, `${label} must be ${MAX_YEAR} or earlier`)
    .optional();

/**
 * Optional URL restricted to http/https.
 *
 * `z.url()` alone also accepts schemes such as `javascript:`, which would be
 * unsafe to render as a link later, so the protocol is pinned here.
 */
const optionalHttpUrl = z
  .string()
  .trim()
  .min(1, "URL must not be empty")
  .pipe(
    z.url({
      protocol: /^https?$/,
      error: "URL must be a valid http or https URL",
    }),
  )
  .optional();

/**
 * A list of strings whose entries are trimmed, blank entries dropped, and exact
 * duplicates removed.
 */
export function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();

  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

/** A list of strings that may be omitted entirely. */
const stringList = () =>
  z.array(z.string()).transform(normalizeStringList).default([]);

export const experienceLevelSchema = z.enum(EXPERIENCE_LEVELS);

export const freshnessDaysSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(7),
  z.literal(14),
]);

export const jobTypeSchema = z.enum(JOB_TYPES);

export const educationSchema = z
  .object({
    school: requiredText("School"),
    degree: requiredText("Degree"),
    fieldOfStudy: optionalText("Field of study"),
    grade: optionalText("Grade"),
    startYear: optionalYear("Start year"),
    endYear: optionalYear("End year"),
    currentlyStudying: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (
      value.startYear !== undefined &&
      value.endYear !== undefined &&
      value.endYear < value.startYear
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endYear"],
        message: "End year must not be before the start year",
      });
    }
  });

export const experienceSchema = z.object({
  company: requiredText("Company"),
  title: requiredText("Title"),
  location: optionalText("Location"),
  description: optionalText("Description"),
  startDate: optionalDateText("Start date"),
  endDate: optionalDateText("End date"),
  currentlyWorking: z.boolean().default(false),
});

export const projectSchema = z.object({
  name: requiredText("Project name"),
  description: optionalText("Description"),
  link: optionalHttpUrl,
  technologies: stringList(),
  startDate: optionalDateText("Project start date"),
  endDate: optionalDateText("Project end date"),
});

export const certificationSchema = z.object({
  name: requiredText("Certification name"),
  issuer: requiredText("Issuer"),
  date: optionalDateText("Certification date"),
  credentialId: optionalText("Credential ID"),
  link: optionalHttpUrl,
});

export const resumeProfileSchema = z.object({
  name: requiredText("Name"),
  headline: optionalText("Headline"),
  summary: optionalText("Summary"),
  location: optionalText("Location"),
  skills: stringList(),
  technologies: stringList(),
  languages: stringList(),
  education: z.array(educationSchema).default([]),
  experience: z.array(experienceSchema).default([]),
  projects: z.array(projectSchema).default([]),
  certifications: z.array(certificationSchema).default([]),
});

export const jobPreferencesSchema = z.object({
  /**
   * The roles this person is looking for.
   *
   * An empty list is valid and means "not decided yet", not "no jobs". The
   * resume parser cannot know someone's intended next role, so a profile created
   * by parsing starts here; the Profile Review page is where the user fills it
   * in. Every consumer is expected to treat an empty list as an unanswered
   * question rather than as a filter that matches nothing.
   */
  targetRoles: stringList(),
  locations: stringList(),
  jobTypes: z.array(jobTypeSchema).default([]),
  experienceLevel: experienceLevelSchema.default("mid"),
  minimumSalary: z
    .number()
    .min(0, "Minimum salary must not be negative")
    .optional(),
  salaryCurrency: z
    .string()
    .trim()
    .min(1, "Salary currency must not be empty")
    .max(12, "Salary currency must be 12 characters or fewer")
    .transform((value) => value.toUpperCase())
    .optional(),
  remoteOnly: z.boolean().default(false),
  freshnessDays: freshnessDaysSchema.default(7),
});

/**
 * Identifier of the resume file attached to this profile, if any.
 *
 * Set by `POST /api/resume` when an upload is linked to a profile; it stays
 * optional so a profile can be created before any resume exists. The pattern
 * mirrors the UUID that the upload flow generates.
 */
export const resumeFileIdSchema = z
  .string()
  .trim()
  .min(1, "Resume file id must not be empty")
  .max(36, "Resume file id must be a UUID")
  .regex(RESUME_FILE_ID_PATTERN, "Resume file id must be a UUID");

/**
 * The complete profile: the resume itself plus how the person wants to be
 * matched, and an optional pointer to the uploaded file those fields came from.
 */
export const jobProfileSchema = z.object({
  resume: resumeProfileSchema,
  preferences: jobPreferencesSchema,
  resumeFileId: resumeFileIdSchema.optional(),
});

export type EducationInput = z.input<typeof educationSchema>;
export type ExperienceInput = z.input<typeof experienceSchema>;
export type ProjectInput = z.input<typeof projectSchema>;
export type CertificationInput = z.input<typeof certificationSchema>;
export type ResumeProfileInput = z.input<typeof resumeProfileSchema>;
export type JobPreferencesInput = z.input<typeof jobPreferencesSchema>;

/** Validated, normalized profile payload ready to be persisted. */
export type ParsedJobProfile = z.output<typeof jobProfileSchema>;

/**
 * Preferences for a profile nobody has filled in yet.
 *
 * Produced by running the schema over an unanswered set rather than by
 * hand-listing defaults, so it cannot drift from the schema. Used when the
 * resume parser creates a profile: the document says what someone has done, not
 * what they want next, and inventing a target role would quietly shape their job
 * search behind their back.
 */
export function createEmptyJobPreferences(): ParsedJobProfile["preferences"] {
  return jobPreferencesSchema.parse({ targetRoles: [] });
}

/**
 * Removes `undefined` and `null` property values from a nested value, returning
 * a copy with those keys omitted.
 *
 * Persistence contract: an optional field a caller deliberately left unanswered
 * must be represented by *absence*, never by `null`. MongoDB's BSON serializer
 * turns a present-but-`undefined` property into `null`, and the stored document
 * schema rejects `null` for optional text, so writing one bricks the profile:
 * every later read fails validation. Zod's parsers can leave optional keys in
 * place with an `undefined` value, so profile writers strip them before anything
 * reaches the database.
 *
 * Dates are passed through untouched; only plain-object properties and array
 * elements are inspected.
 */
export function stripAbsentValues<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripAbsentValues(item)) as T;
  }
  const record = value as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (item === undefined || item === null) {
      continue;
    }
    cleaned[key] = stripAbsentValues(item);
  }
  return cleaned as T;
}