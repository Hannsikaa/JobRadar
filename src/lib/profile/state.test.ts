import { describe, expect, it } from "vitest";

import { deriveProfileState, needsProfileReview } from "@/lib/profile/state";
import { jobPreferencesSchema, resumeProfileSchema } from "@/lib/profile/schemas";
import type { StoredProfile } from "@/lib/profile/types";
import type { ResumeFileMetadata } from "@/lib/resume/types";

/**
 * Tests for the staleness rules.
 *
 * Every case is named after the situation a user would describe, not the field
 * being compared, because the whole point of this module is that "my profile is
 * out of date" has to be decidable from stored data alone.
 */

const RESUME_A = "aaaaaaaa-1111-4111-8111-111111111111";
const RESUME_B = "bbbbbbbb-2222-4222-8222-222222222222";

function resume(id: string): ResumeFileMetadata {
  return {
    id,
    originalFilename: `${id}.pdf`,
    mimeType: "application/pdf",
    extension: "pdf",
    sizeBytes: 1024,
    uploadedAt: "2024-01-01T00:00:00.000Z",
  };
}

/** A profile with provenance fields set only when asked for. */
function profile(overrides: Partial<StoredProfile> = {}): StoredProfile {
  return {
    userId: "demo-1",
    resume: resumeProfileSchema.parse({ name: "Ada" }),
    preferences: jobPreferencesSchema.parse({ targetRoles: ["Backend"] }),
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveProfileState", () => {
  it("reports a first-time user as having neither a resume nor a profile", () => {
    const state = deriveProfileState({ profile: null, resume: null });

    expect(state).toEqual({
      hasResume: false,
      hasProfile: false,
      resumeChangedSinceParse: false,
      profileReviewed: false,
      isCurrent: false,
    });
  });

  it("never calls a missing profile stale", () => {
    // Nothing to be out of date: with no profile there is no text that could be
    // describing the wrong resume.
    const state = deriveProfileState({ profile: null, resume: resume(RESUME_A) });

    expect(state.hasResume).toBe(true);
    expect(state.resumeChangedSinceParse).toBe(false);
  });

  it("reports a profile parsed from the current resume as not stale", () => {
    const state = deriveProfileState({
      profile: profile({ resumeFileId: RESUME_A, parsedResumeFileId: RESUME_A }),
      resume: resume(RESUME_A),
    });

    expect(state.resumeChangedSinceParse).toBe(false);
  });

  it("calls a profile stale once the resume has been replaced", () => {
    // The replacement moved `resumeFileId`; `parsedResumeFileId` still names the
    // file the stored text actually came from.
    const state = deriveProfileState({
      profile: profile({ resumeFileId: RESUME_B, parsedResumeFileId: RESUME_A }),
      resume: resume(RESUME_B),
    });

    expect(state.resumeChangedSinceParse).toBe(true);
  });

  it("calls a profile stale when a resume has never been parsed at all", () => {
    const state = deriveProfileState({
      profile: profile({ resumeFileId: RESUME_A }),
      resume: resume(RESUME_A),
    });

    expect(state.resumeChangedSinceParse).toBe(true);
  });

  it("does not call a resume-less profile stale", () => {
    // Someone can build a profile by hand with no resume involved. There is
    // nothing for it to be out of date relative to.
    const state = deriveProfileState({ profile: profile(), resume: null });

    expect(state.resumeChangedSinceParse).toBe(false);
  });

  it("falls back to the profile's own pointer when the resume is gone", () => {
    // The metadata row is missing, so there is nothing to compare against — and
    // a profile that still matches what it claims is not made stale by that.
    const state = deriveProfileState({
      profile: profile({ resumeFileId: RESUME_A, parsedResumeFileId: RESUME_A }),
      resume: null,
    });

    expect(state.resumeChangedSinceParse).toBe(false);
  });

  it("catches a resume that exists but was never linked to the profile", () => {
    const state = deriveProfileState({
      profile: profile(),
      resume: resume(RESUME_A),
    });

    expect(state.resumeChangedSinceParse).toBe(true);
  });

  it("tracks review separately from staleness", () => {
    const fresh = deriveProfileState({
      profile: profile({ resumeFileId: RESUME_A, parsedResumeFileId: RESUME_A }),
      resume: resume(RESUME_A),
    });

    // Parsed and current, but nobody has opened Profile Review.
    expect(fresh.resumeChangedSinceParse).toBe(false);
    expect(fresh.profileReviewed).toBe(false);
    expect(fresh.isCurrent).toBe(false);

    const reviewed = deriveProfileState({
      profile: profile({
        resumeFileId: RESUME_A,
        parsedResumeFileId: RESUME_A,
        reviewedAt: "2024-02-02T00:00:00.000Z",
      }),
      resume: resume(RESUME_A),
    });

    expect(reviewed.isCurrent).toBe(true);
  });

  it("is not current when a reviewed profile has been overtaken by a new resume", () => {
    const state = deriveProfileState({
      profile: profile({
        resumeFileId: RESUME_B,
        parsedResumeFileId: RESUME_A,
        reviewedAt: "2024-02-02T00:00:00.000Z",
      }),
      resume: resume(RESUME_B),
    });

    // Reviewed yesterday is not a claim about today's file.
    expect(state.profileReviewed).toBe(true);
    expect(state.resumeChangedSinceParse).toBe(true);
    expect(state.isCurrent).toBe(false);
  });

  it("keeps isCurrent consistent with the flags it is built from", () => {
    const cases: Array<[StoredProfile | null, ResumeFileMetadata | null]> = [
      [null, null],
      [null, resume(RESUME_A)],
      [profile(), null],
      [profile({ reviewedAt: "2024-02-02T00:00:00.000Z" }), null],
      [profile({ resumeFileId: RESUME_A, parsedResumeFileId: RESUME_A }), resume(RESUME_A)],
      [profile({ resumeFileId: RESUME_A, parsedResumeFileId: RESUME_A }), resume(RESUME_B)],
      [profile({ resumeFileId: RESUME_B, parsedResumeFileId: RESUME_A }), resume(RESUME_B)],
    ];

    for (const [stored, currentResume] of cases) {
      const state = deriveProfileState({ profile: stored, resume: currentResume });

      expect(state.isCurrent).toBe(
        state.hasProfile && !state.resumeChangedSinceParse && state.profileReviewed,
      );
    }
  });
});

describe("needsProfileReview", () => {
  it("sends a user with no profile to review so one can be built", () => {
    expect(needsProfileReview(deriveProfileState({ profile: null, resume: null }))).toBe(true);
  });

  it("sends a user whose resume has moved on", () => {
    const state = deriveProfileState({
      profile: profile({
        resumeFileId: RESUME_B,
        parsedResumeFileId: RESUME_A,
        reviewedAt: "2024-02-02T00:00:00.000Z",
      }),
      resume: resume(RESUME_B),
    });

    expect(needsProfileReview(state)).toBe(true);
  });

  it("sends a freshly parsed but unreviewed profile", () => {
    const state = deriveProfileState({
      profile: profile({ resumeFileId: RESUME_A, parsedResumeFileId: RESUME_A }),
      resume: resume(RESUME_A),
    });

    expect(needsProfileReview(state)).toBe(true);
  });

  it("leaves a settled profile alone", () => {
    const state = deriveProfileState({
      profile: profile({
        resumeFileId: RESUME_A,
        parsedResumeFileId: RESUME_A,
        reviewedAt: "2024-02-02T00:00:00.000Z",
      }),
      resume: resume(RESUME_A),
    });

    expect(needsProfileReview(state)).toBe(false);
  });

  it("leaves a hand-built, reviewed, resume-less profile alone", () => {
    // No resume was ever uploaded, so there is no parse to be out of date with,
    // and the person confirmed the content themselves.
    const state = deriveProfileState({
      profile: profile({ reviewedAt: "2024-02-02T00:00:00.000Z" }),
      resume: null,
    });

    expect(needsProfileReview(state)).toBe(false);
  });
});