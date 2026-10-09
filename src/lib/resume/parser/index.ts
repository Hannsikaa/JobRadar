/**
 * Main resume parser orchestrating the full pipeline.
 *
 * Pipeline:
 * 1. Read stored file from storage
 * 2. Extract raw text (PDF/DOCX)
 * 3. Normalize text
 * 4. Parse structured profile
 * 5. Validate against schema
 * 6. Persist to the profile repository, creating it when needed and
 *    preserving preferences the user has already set
 */

import {
  createEmptyJobPreferences,
  type JobPreferencesInput,
  resumeProfileSchema,
} from "@/lib/profile/schemas";
import { getResumeFileById } from "@/lib/resume/repository";
import { createLocalResumeStorage } from "@/lib/resume/storage";
import {
  getProfileByUserId,
  saveParsedResumeProfile,
} from "@/lib/profile/repository";

import {
  ResumeNotFoundError,
  ResumeTextExtractionFailedError,
  ResumeParseFailedError,
  ResumeValidationFailedError,
  ResumeStorageUnavailableError,
  ResumeStorageError,
  ProfileUpdateFailedError,
  isResumeParseError,
} from "@/lib/resume/parser/errors";
import {
  extractResumeText,
  type ExtractedText,
} from "@/lib/resume/parser/extraction";
import { normalizeText } from "@/lib/resume/parser/normalization";
import { parseResumeStructure, type ParsedResumeProfile } from "@/lib/resume/parser/structure";
import type {
  ResumeParseResult,
  ResumeParserDependencies,
  ResumeParserConfig,
} from "@/lib/resume/parser/types";
import { DEFAULT_PARSER_CONFIG } from "@/lib/resume/parser/types";

/**
 * Parses a stored resume file into a structured profile and persists it.
 *
 * This is the main entry point for the parsing flow. It:
 * 1. Reads the file from storage
 * 2. Extracts text based on file format
 * 3. Normalizes the extracted text
 * 4. Parses the structure into a ResumeProfile
 * 5. Validates against the Zod schema
 * 6. Writes the result to the user's profile, creating it when this is the
 *    user's first resume and preserving any preferences they already set
 *
 * The parser never invents preferences. It cannot know what roles someone is
 * looking for, so a profile it creates starts with empty preferences for the
 * user to fill in on the Profile Review page.
 */
export async function parseResume(
  userId: string,
  resumeFileId: string,
  dependencies: ResumeParserDependencies,
  config: ResumeParserConfig = DEFAULT_PARSER_CONFIG,
): Promise<ResumeParseResult> {
  // Step 1: Get resume metadata (includes storage key)
  let resumeMeta;
  try {
    resumeMeta = await getResumeFileById(resumeFileId);
  } catch (error) {
    if (isResumeParseError(error)) throw error;
    throw new ResumeStorageUnavailableError("The resume metadata could not be read.", { cause: error });
  }

  if (!resumeMeta) {
    throw new ResumeNotFoundError();
  }

  // Verify ownership
  if (resumeMeta.userId !== userId) {
    throw new ResumeNotFoundError();
  }

  // Step 2: Read file from storage
  let fileBuffer: Uint8Array | null;
  try {
    fileBuffer = await dependencies.storage.read(resumeMeta.storageKey);
  } catch (error) {
    if (isResumeParseError(error)) throw error;
    throw new ResumeStorageError("The resume file could not be read.", { cause: error });
  }

  if (!fileBuffer) {
    throw new ResumeStorageError("The resume file was not found in storage.");
  }

  // Step 3: Extract text
  let extracted: ExtractedText;
  try {
    extracted = await extractResumeText(fileBuffer, resumeMeta.extension);
  } catch (error) {
    if (error instanceof ResumeTextExtractionFailedError) throw error;
    throw new ResumeTextExtractionFailedError("Text extraction failed.", { cause: error });
  }

  // Step 4: Normalize text
  const normalized = normalizeText(extracted);

  // Step 5: Parse structure
  let parsed: ParsedResumeProfile;
  try {
    parsed = parseResumeStructure(normalized);
  } catch (error) {
    throw new ResumeParseFailedError("Failed to parse resume structure.", { cause: error });
  }

  // Step 6: Validate against schema
  const validation = resumeProfileSchema.safeParse(parsed.profile);
  if (!validation.success) {
    // Try to normalize and re-validate
    const normalizedProfile = attemptNormalization(parsed.profile);
    const retry = resumeProfileSchema.safeParse(normalizedProfile);
    if (!retry.success) {
      throw new ResumeValidationFailedError(
        "The parsed resume does not match the expected structure.",
        { cause: retry.error },
      );
    }
    parsed.profile = retry.data;
  } else {
    parsed.profile = validation.data;
  }

  // Step 7: Persist to the profile.
  //
  // Parsing creates the profile when this is the user's first resume, so the
  // write is an upsert. Preferences are never invented or overwritten here: the
  // parser can read someone's history out of a document but not what they want
  // next, so an existing profile keeps exactly the preferences the user set and
  // a new one starts from the schema's own defaults.
  let existingProfile;
  try {
    existingProfile = await getProfileByUserId(userId);
  } catch (error) {
    throw new ProfileUpdateFailedError("The profile could not be read.", { cause: error });
  }

  try {
    await saveParsedResumeProfile(userId, {
      resume: parsed.profile,
      preferences: existingProfile?.preferences ?? defaultParsedPreferences(),
      resumeFileId,
    });
  } catch (error) {
    throw new ProfileUpdateFailedError("The profile could not be updated with the parsed resume.", {
      cause: error,
    });
  }

  // Success
  return {
    success: true,
    profile: parsed.profile,
    rawText: config.includeRawText ? normalized.text : undefined,
    warnings: parsed.warnings,
  };
}

/**
 * Attempts to normalize a profile that failed validation.
 *
 * Conservative normalization only - does not invent data.
 */
function attemptNormalization(profile: ParsedResumeProfile["profile"]): ParsedResumeProfile["profile"] {
  return {
    ...profile,
    name: profile.name?.trim() ?? "",
    headline: profile.headline?.trim(),
    summary: profile.summary?.trim(),
    location: profile.location?.trim(),
    skills: profile.skills?.map((s: string) => s.trim()).filter((s: string) => s.length > 0) ?? [],
    technologies: profile.technologies?.map((s: string) => s.trim()).filter((s: string) => s.length > 0) ?? [],
    languages: profile.languages?.map((s: string) => s.trim()).filter((s: string) => s.length > 0) ?? [],
    education: profile.education?.map((e) => ({
      ...e,
      degree: e.degree?.trim() ?? "",
      school: e.school?.trim() ?? "",
      fieldOfStudy: e.fieldOfStudy?.trim(),
      grade: e.grade?.trim(),
    })) ?? [],
    experience: profile.experience?.map((e) => ({
      ...e,
      title: e.title?.trim() ?? "",
      company: e.company?.trim() ?? "",
      location: e.location?.trim(),
      description: e.description?.trim(),
    })) ?? [],
    projects: profile.projects?.map((p) => ({
      ...p,
      name: p.name?.trim() ?? "",
      description: p.description?.trim(),
      technologies: p.technologies?.map((s: string) => s.trim()).filter((s: string) => s.length > 0) ?? [],
      link: p.link?.trim(),
    })) ?? [],
    certifications: profile.certifications?.map((c) => ({
      ...c,
      name: c.name?.trim() ?? "",
      issuer: c.issuer?.trim() ?? "",
      date: c.date?.trim(),
      credentialId: c.credentialId?.trim(),
      link: c.link?.trim(),
    })) ?? [],
  };
}

/**
 * Preferences a parser-created profile starts with.
 *
 * Delegates to the schema so the defaults are whatever the schema says they are,
 * and stays empty apart from them: see `createEmptyJobPreferences`.
 */
function defaultParsedPreferences(): JobPreferencesInput {
  return createEmptyJobPreferences();
}

/**
 * Creates the default parser dependencies using the local storage adapter.
 *
 * Storage is the only swappable piece. The profile write is not offered as a
 * dependency because the parser's job includes deciding what to write — it
 * preserves existing preferences, creates the profile when there is none, and
 * records which file the text came from. A caller-supplied stand-in could not
 * express any of that, so it was removed rather than left in place as a
 * misleading second path.
 */
export function createDefaultParserDependencies(): ResumeParserDependencies {
  return {
    storage: createLocalResumeStorage(),
  };
}

/**
 * High-level function that uses default dependencies.
 * Convenience wrapper for the API route.
 */
export async function parseResumeForUser(
  userId: string,
  resumeFileId: string,
): Promise<ResumeParseResult> {
  const dependencies = createDefaultParserDependencies();
  return parseResume(userId, resumeFileId, dependencies);
}