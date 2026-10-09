import type { z } from "zod";

import type {
  certificationSchema,
  educationSchema,
  experienceSchema,
  jobPreferencesSchema,
  jobProfileSchema,
  projectSchema,
  resumeProfileSchema,
} from "@/lib/profile/schemas";

/**
 * Type layer for the profile domain.
 *
 * These types are derived from the Zod schemas in `./schemas` so the shape used
 * by the rest of the app can never drift from what is actually validated. Only
 * this file imports schema *types*; `./schemas` never imports from here, which
 * keeps the validation layer free of dependencies on the rest of the profile
 * code.
 */

export type Education = z.infer<typeof educationSchema>;
export type Experience = z.infer<typeof experienceSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Certification = z.infer<typeof certificationSchema>;
export type ResumeProfile = z.infer<typeof resumeProfileSchema>;
export type JobPreferences = z.infer<typeof jobPreferencesSchema>;

/** The resume and preferences that make up a user's job profile. */
export type JobProfile = z.infer<typeof jobProfileSchema>;

/**
 * What callers hand to validation. Optional fields and defaulted arrays may be
 * omitted here even though they always exist on a `JobProfile`.
 */
export type JobProfileInput = z.input<typeof jobProfileSchema>;

/**
 * A stored profile as the rest of the app consumes it.
 *
 * `createdAt`/`updatedAt` are ISO 8601 strings rather than `Date` objects:
 * MongoDB stores them as BSON dates, but they are serialized at the API
 * boundary so the payload stays JSON-safe.
 *
 * `resumeFileId`, `parsedResumeFileId`, and `reviewedAt` are server-owned
 * provenance, not user input: they are written by the upload, parse, and review
 * flows respectively and are stripped from anything a client submits. They are
 * exposed so a client can tell whether the profile text still matches the
 * current resume without having to guess; see `@/lib/profile/state` for the
 * rules built on top of them.
 */
export type StoredProfile = JobProfile & {
  userId: string;
  createdAt: string;
  updatedAt: string;
  /** The upload this profile is currently linked to. */
  resumeFileId?: string;
  /** The upload the stored `resume` text was parsed from. */
  parsedResumeFileId?: string;
  /** When a person last saved this profile through Profile Review. */
  reviewedAt?: string;
};

/** A single validation problem, addressed by its path in the submitted object. */
export type ValidationIssue = {
  path: string;
  message: string;
};