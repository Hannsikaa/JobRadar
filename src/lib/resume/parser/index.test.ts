import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResumeNotFoundError, ResumeTextExtractionFailedError, ResumeParseFailedError, ResumeValidationFailedError, ProfileUpdateFailedError, ResumeStorageError } from "@/lib/resume/parser/errors";
import { parseResume, createDefaultParserDependencies } from "@/lib/resume/parser";
import { getResumeFileById } from "@/lib/resume/repository";
import { getProfileByUserId, saveParsedResumeProfile } from "@/lib/profile/repository";
import { createLocalResumeStorage } from "@/lib/resume/storage";

vi.mock("@/lib/resume/repository", () => ({ getResumeFileById: vi.fn() }));
vi.mock("@/lib/profile/repository", () => ({ getProfileByUserId: vi.fn(), saveParsedResumeProfile: vi.fn() }));
vi.mock("@/lib/resume/storage", () => ({ createLocalResumeStorage: vi.fn() }));
vi.mock("@/lib/resume/parser/extraction", () => ({ extractResumeText: vi.fn() }));
vi.mock("@/lib/resume/parser/normalization", () => ({ normalizeText: vi.fn() }));
vi.mock("@/lib/resume/parser/structure", () => ({ parseResumeStructure: vi.fn() }));

const mockedGetResumeFileById = vi.mocked(getResumeFileById);
const mockedGetProfileByUserId = vi.mocked(getProfileByUserId);
const mockedSaveParsedProfile = vi.mocked(saveParsedResumeProfile);
const mockedCreateLocalStorage = vi.mocked(createLocalResumeStorage);
const mockedExtractResumeText = vi.mocked((await import("@/lib/resume/parser/extraction")).extractResumeText);
const mockedNormalizeText = vi.mocked((await import("@/lib/resume/parser/normalization")).normalizeText);
const mockedParseResumeStructure = vi.mocked((await import("@/lib/resume/parser/structure")).parseResumeStructure);

const USER_ID = "user-1";
const RESUME_FILE_ID = "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b";
const STORAGE_KEY = `${RESUME_FILE_ID}.pdf`;

function makeResumeMeta(overrides: Partial<{ id: string; userId: string; storageKey: string; extension: "pdf" | "docx" }> = {}) {
  return {
    id: RESUME_FILE_ID,
    userId: USER_ID,
    storageKey: STORAGE_KEY,
    extension: "pdf" as const,
    originalFilename: "resume.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    uploadedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

import type { ResumeProfileInput, JobPreferencesInput } from "@/lib/profile/schemas";

function makeProfile(overrides: Partial<{ resume: ResumeProfileInput; preferences: JobPreferencesInput }> = {}) {
  return {
    userId: USER_ID,
    resume: {
      name: "John Doe",
      skills: ["TypeScript"],
      education: [],
      experience: [],
      projects: [],
      certifications: [],
      technologies: [],
      languages: [],
      ...overrides.resume,
    },
    preferences: {
      targetRoles: ["Software Engineer"],
      locations: [],
      jobTypes: [],
      experienceLevel: "mid",
      remoteOnly: false,
      freshnessDays: 7,
      ...overrides.preferences,
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeExtractedText(text: string) {
  return { text, charCount: text.length, lineCount: text.split("\n").length };
}

function makeNormalizedText(text: string) {
  return { text, originalCharCount: text.length, originalLineCount: text.split("\n").length };
}

import type { ParsedResumeProfile } from "@/lib/resume/parser/types";

function makeParsedProfile(overrides: Partial<ParsedResumeProfile> = {}) {
  return {
    profile: {
      name: "John Doe",
      headline: undefined,
      summary: undefined,
      location: undefined,
      skills: ["TypeScript", "React"],
      technologies: [],
      languages: [],
      education: [],
      experience: [],
      projects: [],
      certifications: [],
      ...overrides,
    },
    warnings: [],
  };
}

function useSuccessfulMocks() {
  mockedGetResumeFileById.mockResolvedValue(makeResumeMeta());
  mockedGetProfileByUserId.mockResolvedValue(makeProfile());
  mockedSaveParsedProfile.mockResolvedValue(makeProfile());
  mockedCreateLocalStorage.mockReturnValue({
    read: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    save: vi.fn(),
    delete: vi.fn(),
  });
  mockedExtractResumeText.mockResolvedValue(makeExtractedText("John Doe\nSoftware Engineer\n\nSkills\nTypeScript, React"));
  mockedNormalizeText.mockReturnValue(makeNormalizedText("John Doe\nSoftware Engineer\n\nSkills\nTypeScript, React"));
  mockedParseResumeStructure.mockReturnValue(makeParsedProfile());
}

beforeEach(() => {
  vi.clearAllMocks();
  useSuccessfulMocks();
});

describe("parseResume", () => {
  it("parses a resume and writes the profile", async () => {
    const dependencies = createDefaultParserDependencies();
    const result = await parseResume(USER_ID, RESUME_FILE_ID, dependencies);

    expect(result.success).toBe(true);
    expect(result.profile.name).toBe("John Doe");
    expect(result.profile.skills).toContain("TypeScript");
    expect(mockedGetResumeFileById).toHaveBeenCalledWith(RESUME_FILE_ID);
    expect(mockedGetProfileByUserId).toHaveBeenCalledWith(USER_ID);
    expect(mockedSaveParsedProfile).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      resume: expect.objectContaining({ name: "John Doe" }),
      preferences: expect.objectContaining({}),
    }));
  });

  it("includes raw text when config.includeRawText is true", async () => {
    const dependencies = createDefaultParserDependencies();
    const result = await parseResume(USER_ID, RESUME_FILE_ID, dependencies, { includeRawText: true, minTextLength: 50 });

    expect(result.rawText).toBeDefined();
    expect(typeof result.rawText).toBe("string");
  });

  it("throws ResumeNotFoundError when resume metadata not found", async () => {
    mockedGetResumeFileById.mockResolvedValue(null);

    const dependencies = createDefaultParserDependencies();
    await expect(parseResume(USER_ID, RESUME_FILE_ID, dependencies)).rejects.toBeInstanceOf(ResumeNotFoundError);
  });

  it("throws ResumeNotFoundError when resume belongs to different user", async () => {
    mockedGetResumeFileById.mockResolvedValue(makeResumeMeta({ userId: "other-user" }));

    const dependencies = createDefaultParserDependencies();
    await expect(parseResume(USER_ID, RESUME_FILE_ID, dependencies)).rejects.toBeInstanceOf(ResumeNotFoundError);
  });

  it("throws ResumeStorageError when file not found in storage", async () => {
    mockedCreateLocalStorage.mockReturnValue({
      read: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
      delete: vi.fn(),
    });

    const dependencies = createDefaultParserDependencies();
    await expect(parseResume(USER_ID, RESUME_FILE_ID, dependencies)).rejects.toBeInstanceOf(ResumeStorageError);
  });

  it("throws ResumeTextExtractionFailedError when extraction fails", async () => {
    mockedExtractResumeText.mockRejectedValue(new ResumeTextExtractionFailedError("No text"));

    const dependencies = createDefaultParserDependencies();
    await expect(parseResume(USER_ID, RESUME_FILE_ID, dependencies)).rejects.toBeInstanceOf(ResumeTextExtractionFailedError);
  });

  it("throws ResumeParseFailedError when structure parsing fails", async () => {
    mockedParseResumeStructure.mockImplementation(() => {
      throw new Error("Parse failed");
    });

    const dependencies = createDefaultParserDependencies();
    await expect(parseResume(USER_ID, RESUME_FILE_ID, dependencies)).rejects.toBeInstanceOf(ResumeParseFailedError);
  });

  it("throws ResumeValidationFailedError when schema validation fails", async () => {
    mockedParseResumeStructure.mockReturnValue({
      profile: { name: "" }, // Invalid: name is required
      warnings: [],
    });

    const dependencies = createDefaultParserDependencies();
    await expect(parseResume(USER_ID, RESUME_FILE_ID, dependencies)).rejects.toBeInstanceOf(ResumeValidationFailedError);
  });

  it("creates the profile when the user has none yet", async () => {
    mockedGetProfileByUserId.mockResolvedValue(null);

    const dependencies = createDefaultParserDependencies();
    await parseResume(USER_ID, RESUME_FILE_ID, dependencies);

    // Parsing is the step that creates a profile, so a first-time user must not
    // be told their profile is missing. Preferences are the schema's own
    // defaults because the parser cannot know what they are after.
    expect(mockedSaveParsedProfile).toHaveBeenCalledTimes(1);
    expect(mockedSaveParsedProfile.mock.calls[0][1]).toMatchObject({
      resumeFileId: RESUME_FILE_ID,
      preferences: { targetRoles: [], experienceLevel: "mid", freshnessDays: 7 },
    });
  });

  it("throws ProfileUpdateFailedError when the profile write fails", async () => {
    mockedSaveParsedProfile.mockRejectedValue(new Error("DB error"));

    const dependencies = createDefaultParserDependencies();
    await expect(parseResume(USER_ID, RESUME_FILE_ID, dependencies)).rejects.toBeInstanceOf(ProfileUpdateFailedError);
  });

  it("throws ProfileUpdateFailedError when the profile read fails", async () => {
    mockedGetProfileByUserId.mockRejectedValue(new Error("DB error"));

    const dependencies = createDefaultParserDependencies();
    await expect(parseResume(USER_ID, RESUME_FILE_ID, dependencies)).rejects.toBeInstanceOf(ProfileUpdateFailedError);
  });

  it("preserves existing preferences when updating profile", async () => {
    const existingPrefs = { targetRoles: ["Backend Engineer"], locations: ["Remote"] };
    mockedGetProfileByUserId.mockResolvedValue(makeProfile({ preferences: existingPrefs }));

    const dependencies = createDefaultParserDependencies();
    await parseResume(USER_ID, RESUME_FILE_ID, dependencies);

    expect(mockedSaveParsedProfile).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      preferences: expect.objectContaining(existingPrefs),
    }));
  });

  it("records which resume file the parsed text came from", async () => {
    const dependencies = createDefaultParserDependencies();
    await parseResume(USER_ID, RESUME_FILE_ID, dependencies);

    // The repository uses this to record provenance; the parser must supply it.
    expect(mockedSaveParsedProfile.mock.calls[0][1].resumeFileId).toBe(RESUME_FILE_ID);
  });
});

describe("createDefaultParserDependencies", () => {
  it("returns dependencies with a readable storage adapter", () => {
    const deps = createDefaultParserDependencies();

    expect(deps.storage).toBeDefined();
    expect(typeof deps.storage.read).toBe("function");
  });

  it("does not expose a profile repository to swap out", () => {
    // Persisting the parsed profile is the pipeline's job, not a caller choice:
    // an injectable stand-in could not express "keep the user's preferences, or
    // create the profile with defaults".
    expect(createDefaultParserDependencies()).not.toHaveProperty("profileRepository");
  });
});