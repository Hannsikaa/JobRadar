import type { ResumeFileMetadata } from "@/lib/resume/types";
import type { StoredProfile } from "@/lib/profile/types";

/**
 * Where a user's profile stands relative to their resume.
 *
 * Three server-owned fields answer three different questions, and mixing them up
 * is what makes a UI quietly lie about being up to date:
 *
 * - `resumeFileId` — the upload this profile is attached to. Moved by every
 *   upload, including replacements.
 * - `parsedResumeFileId` — the upload the stored profile text was extracted
 *   from. Moved only by a parse.
 * - `reviewedAt` — when a person last saved the profile through Profile Review.
 *
 * Comparing the first two is the staleness signal: they agree exactly when the
 * profile text was extracted from the file the user currently has. `reviewedAt`
 * is the separate, weaker question of whether anyone has looked at the result.
 * A profile can be perfectly current and unreviewed (freshly parsed, never
 * opened), and it can be reviewed and stale (reviewed yesterday, new resume
 * uploaded since) — so neither flag implies the other, and neither is inferred
 * from a bare `updatedAt`, which changes for reasons that say nothing about
 * whether the content is right.
 *
 * Deliberately a pure function over data the client already has. It touches no
 * storage and issues no request, so a page can recompute it after any write
 * without a round trip and without a second source of truth to keep in sync.
 */

/** What the client needs to decide whether the profile can be trusted. */
export type ProfileStateInput = {
  /** The user's profile, or `null` when they have not created one yet. */
  profile: StoredProfile | null;
  /** The user's current resume, or `null` when they have not uploaded one. */
  resume: ResumeFileMetadata | null;
};

/** The derived flags, each answering exactly one question. */
export type ProfileState = {
  /** The user has a resume on file. */
  hasResume: boolean;
  /** The user has a profile. */
  hasProfile: boolean;
  /**
   * The profile text does not describe the resume the user has now.
   *
   * True after a replacement upload that was not re-parsed, and true when a
   * resume exists that no parse has ever covered. False when the two file
   * pointers agree, including when neither exists — with no resume involved
   * there is nothing to be out of date relative to.
   */
  resumeChangedSinceParse: boolean;
  /** A person has saved this profile through Profile Review. */
  profileReviewed: boolean;
  /**
   * The profile can be treated as settled: it describes the current resume and
   * someone has confirmed it. The single flag a caller should gate on before
   * acting on the profile as if it were final.
   */
  isCurrent: boolean;
};

/**
 * Derives the staleness flags for a user.
 *
 * `isCurrent` is derived rather than stored so it cannot drift out of agreement
 * with the flags it is made of; there is no fourth field to keep updated.
 */
export function deriveProfileState(input: ProfileStateInput): ProfileState {
  const { profile, resume } = input;
  const hasProfile = profile !== null;

  if (!hasProfile) {
    // Nothing to be stale: with no profile there is no text that could be
    // describing the wrong resume.
    return {
      hasResume: resume !== null,
      hasProfile: false,
      resumeChangedSinceParse: false,
      profileReviewed: false,
      isCurrent: false,
    };
  }

  // The file the user is effectively holding. The profile's own pointer is the
  // fallback, so a resume whose metadata has gone missing does not make the
  // profile look stale against a file it never claimed to match.
  const currentResumeFileId = resume?.id ?? profile.resumeFileId;
  const parsedFrom = profile.parsedResumeFileId;

  // Equal means the stored text came from the resume the user has now. This one
  // comparison covers both ways of diverging: a replacement upload that was
  // never re-parsed (pointers name different files), and a resume that has
  // never been parsed at all (one pointer set, the other absent).
  const resumeChangedSinceParse = currentResumeFileId !== parsedFrom;
  const profileReviewed = profile.reviewedAt !== undefined;

  return {
    hasResume: resume !== null,
    hasProfile: true,
    resumeChangedSinceParse,
    profileReviewed,
    isCurrent: !resumeChangedSinceParse && profileReviewed,
  };
}

/**
 * Whether a user should be sent to Profile Review.
 *
 * Kept separate from {@link ProfileState} so "there is something to review" is
 * a policy decision in one place rather than an inline `||` at every call site
 * that would drift apart.
 *
 * True for a user with no profile yet — there is nothing to review, but there is
 * everything to fill in — and for one whose profile is not current. A user with
 * no resume but a reviewed profile is left alone: they chose to build a profile
 * by hand and it is their own.
 */
export function needsProfileReview(state: ProfileState): boolean {
  return !state.hasProfile || !state.isCurrent;
}