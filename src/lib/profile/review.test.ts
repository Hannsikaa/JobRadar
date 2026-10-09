import { describe, expect, it } from "vitest";

import {
  createProfileDraft,
  listToText,
  textToList,
  toJobProfileInput,
  validateDraft,
} from "@/lib/profile/review";
import { jobPreferencesSchema, resumeProfileSchema } from "@/lib/profile/schemas";
import type { StoredProfile } from "@/lib/profile/types";

/**
 * Tests for the Profile Review page's logic.
 *
 * The page is a component and this suite runs in a node environment, so the parts
 * worth testing — draft construction, list parsing, and the save-time
 * validation gate — live here as plain functions. What stays in the component is
 * only rendering and wiring.
 */

function storedProfile(overrides: Partial<StoredProfile> = {}): StoredProfile {
  return {
    userId: "demo-1",
    resume: resumeProfileSchema.parse({
      name: "Ada",
      headline: "Backend Engineer",
      skills: ["TypeScript"],
      experience: [{ company: "Analytical Engines", title: "Engineer" }],
    }),
    preferences: jobPreferencesSchema.parse({
      targetRoles: ["Backend Engineer"],
      locations: ["Berlin"],
    }),
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createProfileDraft", () => {
  it("copies the stored profile into an editable draft", () => {
    const draft = createProfileDraft(storedProfile());

    expect(draft.resume.name).toBe("Ada");
    expect(draft.preferences.targetRoles).toEqual(["Backend Engineer"]);
  });

  it("does not alias the stored profile, so editing cannot mutate what was loaded", () => {
    const stored = storedProfile();

    const draft = createProfileDraft(stored);
    draft.resume.name = "Grace";
    draft.preferences.targetRoles.push("Platform Engineer");
    draft.resume.skills.push("MongoDB");

    expect(stored.resume.name).toBe("Ada");
    expect(stored.preferences.targetRoles).toEqual(["Backend Engineer"]);
    expect(stored.resume.skills).toEqual(["TypeScript"]);
  });

  it("carries the whole profile through, including fields the form does not show", () => {
    const stored = storedProfile({ resumeFileId: "aaaaaaaa-1111-4111-8111-111111111111" });

    const draft = createProfileDraft(stored);

    // The draft is the full profile, not the subset the form renders, so a field
    // the page does not edit cannot be dropped on the way back to the database.
    expect(draft.resume.experience).toEqual([
      { company: "Analytical Engines", title: "Engineer", currentlyWorking: false },
    ]);
    expect(draft.resume.headline).toBe("Backend Engineer");
  });

  it("produces a complete, empty draft when no profile exists", () => {
    const draft = createProfileDraft(null);

    // Every list is present so the form never has to handle a missing field.
    expect(draft.resume.skills).toEqual([]);
    expect(draft.resume.education).toEqual([]);
    expect(draft.resume.experience).toEqual([]);
    expect(draft.resume.projects).toEqual([]);
    expect(draft.resume.certifications).toEqual([]);
    expect(draft.preferences.targetRoles).toEqual([]);
  });

  it("produces a draft that fails validation when there is no profile", () => {
    // "No profile yet" must be reported as a missing name, not saved as a blank
    // record that claims the user is called nothing.
    const result = validateDraft(createProfileDraft(null));

    expect(result.ok).toBe(false);
  });

  it("hands out an independent draft each time", () => {
    const first = createProfileDraft(null);
    first.resume.name = "Ada";

    expect(createProfileDraft(null).resume.name).toBe("");
  });
});

describe("toJobProfileInput", () => {
  it("submits both halves of the profile", () => {
    // `PUT` replaces both halves, so a body carrying only `resume` cannot be a
    // valid save — the preferences the parser set would be lost to schema defaults.
    const input = toJobProfileInput(createProfileDraft(storedProfile()));

    expect(input).toHaveProperty("resume");
    expect(input).toHaveProperty("preferences");
  });

  it("does not carry server-owned provenance into the request", () => {
    const stored = storedProfile({
      resumeFileId: "aaaaaaaa-1111-4111-8111-111111111111",
      parsedResumeFileId: "aaaaaaaa-1111-4111-8111-111111111111",
      reviewedAt: "2024-02-02T00:00:00.000Z",
    });

    const input = toJobProfileInput(createProfileDraft(stored)) as Record<string, unknown>;

    expect(input).not.toHaveProperty("reviewedAt");
    expect(input).not.toHaveProperty("createdAt");
    expect(input).not.toHaveProperty("userId");
  });
});

describe("validateDraft", () => {
  it("accepts a draft loaded from a valid stored profile", () => {
    const result = validateDraft(createProfileDraft(storedProfile()));

    expect(result.ok).toBe(true);
  });

  it("reports the field path for a missing name", () => {
    const draft = createProfileDraft(storedProfile());
    draft.resume.name = "";

    const result = validateDraft(draft);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ path: "resume.name", message: expect.any(String) });
  });

  it("prefixes preference problems with their own half", () => {
    const draft = createProfileDraft(storedProfile());
    draft.preferences.experienceLevel = "principal" as never;

    const result = validateDraft(draft);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path.startsWith("preferences."))).toBe(true);
  });

  it("reports an address inside a repeated section", () => {
    const draft = createProfileDraft(storedProfile());
    draft.resume.experience[0] = { company: "", title: "" };

    const result = validateDraft(draft);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain("resume.experience.0.company");
  });

  it("accepts empty target roles, which is an unanswered question not an error", () => {
    const draft = createProfileDraft(storedProfile());
    draft.preferences.targetRoles = [];

    expect(validateDraft(draft).ok).toBe(true);
  });

  it("returns the normalized payload so the saved form matches the schema", () => {
    const draft = createProfileDraft(storedProfile());
    draft.resume.skills = [" TypeScript ", "TypeScript", "  "];
    draft.preferences.locations = [" Berlin ", "Berlin"];

    const result = validateDraft(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resume.skills).toEqual(["TypeScript"]);
    expect(result.value.preferences.locations).toEqual(["Berlin"]);
  });

  it("does not modify the draft while validating", () => {
    const draft = createProfileDraft(storedProfile());
    draft.resume.name = "  Ada  ";

    validateDraft(draft);

    // A rejected draft has to stay exactly as the user left it, or the next
    // keystroke would compound the edit.
    expect(draft.resume.name).toBe("  Ada  ");
  });
});

describe("listToText and textToList", () => {
  it("renders a list for a text field", () => {
    expect(listToText(["TypeScript", "React"])).toBe("TypeScript, React");
  });

  it("renders an empty list as an empty field", () => {
    expect(listToText([])).toBe("");
  });

  it("splits edited text on commas and newlines", () => {
    // A list pasted from anywhere else is as likely to arrive one per line.
    expect(textToList("TypeScript, React\nMongoDB")).toEqual(["TypeScript", "React", "MongoDB"]);
  });

  it("trims entries, drops blanks, and removes duplicates", () => {
    expect(textToList("  TypeScript ,, React ,\n TypeScript ,  ")).toEqual([
      "TypeScript",
      "React",
    ]);
  });

  it("survives a round trip", () => {
    const values = ["TypeScript", "React"];

    expect(textToList(listToText(values))).toEqual(values);
  });

  it("keeps distinct casings as distinct entries", () => {
    // Matches the schema: "React" and "react" are not the same skill.
    expect(textToList("React, react")).toEqual(["React", "react"]);
  });
});