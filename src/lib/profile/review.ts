import {
  createEmptyJobPreferences,
  jobProfileSchema,
} from "@/lib/profile/schemas";
import type {
  JobPreferences,
  JobProfileInput,
  ResumeProfile,
  StoredProfile,
  ValidationIssue,
} from "@/lib/profile/types";

/**
 * The editable form of a profile.
 *
 * This is exactly the payload the API accepts, deliberately: the draft a person
 * edits is the payload that gets saved, so there is no translation step where a
 * field could be silently dropped on the way to the database. Anything the form
 * does not expose is still carried through unchanged, because a draft is a full
 * `JobProfile` rather than the subset of fields that happen to be rendered.
 */
export type ProfileDraft = {
  resume: ResumeProfile;
  preferences: JobPreferences;
};

/**
 * The resume half of a blank draft: every list present and empty, every optional
 * field absent.
 *
 * Built literally rather than by running the schema over `{ name: "" }`, because
 * the schema is right to reject that — an empty name is exactly the problem the
 * form must surface. The lists are written out so the draft is the same complete
 * shape a validated profile has, which keeps editing code from having to handle
 * `undefined` before the first save.
 */
const BLANK_RESUME: ResumeProfile = {
  name: "",
  skills: [],
  technologies: [],
  languages: [],
  education: [],
  experience: [],
  projects: [],
  certifications: [],
};

/**
 * Builds the starting draft for the Profile Review page.
 *
 * A stored profile is copied into a draft rather than referenced, so editing a
 * field cannot mutate the object the page believes the server sent — cancelling
 * out of the page would otherwise be impossible without a reload.
 *
 * A `null` profile produces a blank draft instead of `null`, so the page has one
 * shape to render. It is deliberately *not* valid: `name` is empty and
 * preferences are unanswered, which is the honest description of "no profile
 * yet" and makes the form say what is missing rather than saving a blank record.
 * The page decides whether to show that as an empty state instead.
 */
export function createProfileDraft(stored: StoredProfile | null): ProfileDraft {
  if (stored === null) {
    return { resume: { ...BLANK_RESUME }, preferences: createEmptyJobPreferences() };
  }

  return {
    resume: structuredClone(stored.resume),
    preferences: structuredClone(stored.preferences),
  };
}

/**
 * The body for `PUT /api/profile`.
 *
 * Strips nothing and adds nothing: the whole draft is submitted, both halves.
 * The page's other reported failure — saving only `resume` — cannot happen
 * through this function because there is no partial form of it.
 */
export function toJobProfileInput(draft: ProfileDraft): JobProfileInput {
  return { resume: draft.resume, preferences: draft.preferences };
}

/** Either the normalized payload, or the problems that stopped it. */
export type DraftValidation =
  | { ok: true; value: JobProfileInput }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Validates a draft with the same schemas the server uses.
 *
 * Exists so the page can show field problems without a round trip and, more
 * importantly, so an invalid draft is *never sent*. `PUT` replaces both halves
 * of the profile, so a partially valid draft submitted as-is would overwrite
 * good data with a rejected payload — the server's validation is the backstop,
 * but not making the request at all means nothing can be lost while the user is
 * still typing.
 *
 * Issue paths are prefixed with `resume` or `preferences`, matching what the API
 * returns, so one renderer handles both sources.
 */
export function validateDraft(draft: ProfileDraft): DraftValidation {
  const parsed = jobProfileSchema.safeParse(toJobProfileInput(draft));
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Renders a list field as editable text.
 *
 * A comma-separated string rather than a set of inputs, because the alternative
 * is a chip editor that cannot be keyboard-typed into and is far more code for no
 * gain at this stage.
 */
export function listToText(values: readonly string[]): string {
  return values.join(", ");
}

/**
 * Parses edited text back into a list.
 *
 * Splits on commas and newlines, because a list pasted in from anywhere else is
 * as likely to arrive one-per-line. Blank entries are dropped and duplicates
 * removed here rather than left for the schema, so the value held in the draft
 * already matches what would be persisted — the schema's normalization is still
 * applied on save and remains the authority, this just keeps the form honest
 * about what it has.
 */
export function textToList(text: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const entry of text.split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    values.push(trimmed);
  }

  return values;
}