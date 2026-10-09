/**
 * Shared types for the resume parsing domain.
 *
 * This module is deliberately dependency-free so that both the server-side
 * parsing layer and any future client-side code can import it.
 */

import { ResumeFileExtension } from "@/lib/resume/types";
import type { ResumeProfileInput } from "@/lib/profile/schemas";

/** Input to the parser: the stored resume file metadata and its bytes. */
export interface ResumeParserInput {
  /** The storage key (e.g., "uuid.pdf") used to read the file. */
  storageKey: string;
  /** The file extension, already validated at upload time. */
  extension: ResumeFileExtension;
  /** The original filename for display purposes. */
  originalFilename: string;
}

/** Raw text extracted from a document. */
export interface ExtractedText {
  /** The raw text content. */
  text: string;
  /** Number of characters extracted. */
  charCount: number;
  /** Number of lines extracted. */
  lineCount: number;
}

/** Normalized text ready for structured parsing. */
export interface NormalizedText {
  /** The normalized text content. */
  text: string;
  /** Original character count before normalization. */
  originalCharCount: number;
  /** Original line count before normalization. */
  originalLineCount: number;
}

/** Result of the structured parsing step. */
export interface ParsedResumeProfile {
  /** The parsed profile data. */
  profile: ResumeProfileInput;
  /** Warnings encountered during parsing (non-fatal). */
  warnings: string[];
}

/** Final result of the full parse pipeline. */
export type ResumeParseResult =
  | {
      success: true;
      profile: ResumeProfileInput;
      rawText?: string;
      warnings: string[];
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

/**
 * Dependencies the parser needs (for testing and DI).
 *
 * Storage only. The profile write is deliberately *not* injectable: persisting
 * the parsed profile is the whole point of the pipeline, and routing it through
 * a two-method stand-in meant the caller had to supply preferences and a resume
 * id that only this module knows. Injecting it made the "preserve the user's
 * existing preferences, or start from the schema defaults" rule impossible to
 * express, because the interface had no way to say which of the two it was.
 */
export interface ResumeParserDependencies {
  /** Storage adapter to read the resume file. */
  storage: {
    read(key: string): Promise<Uint8Array | null>;
  };
}

/** Configuration for the parser. */
export interface ResumeParserConfig {
  /** Minimum characters required to consider extraction successful. */
  minTextLength: number;
  /** Whether to include raw text in successful results (for debugging). */
  includeRawText: boolean;
}

/** Default parser configuration. */
export const DEFAULT_PARSER_CONFIG: ResumeParserConfig = {
  minTextLength: 50,
  includeRawText: false,
};

// Re-export for convenience
export type { ResumeFileExtension, ResumeProfileInput };