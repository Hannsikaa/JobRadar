/**
 * Document text extraction for PDF and DOCX files.
 *
 * This module handles the format-specific extraction of raw text from
 * uploaded resume files. It knows about file formats but does not
 * interpret the content — that is the job of the structure parser.
 */

import { PDFParse } from "pdf-parse";
import * as mammoth from "mammoth";

import { ResumeTextExtractionFailedError } from "@/lib/resume/parser/errors";
import type { ExtractedText, ResumeFileExtension } from "@/lib/resume/parser/types";

/** Minimum characters to consider extraction successful. */
const MIN_EXTRACTED_CHARS = 10;

/**
 * Extracts text from a PDF buffer.
 *
 * Uses pdf-parse which is a server-side PDF text extractor. It does not
 * require a browser environment and works in Node.js.
 */
export async function extractPdfText(buffer: Uint8Array): Promise<ExtractedText> {
  try {
    const parser = new PDFParse({ data: buffer });
    // pdf-parse injects a "-- page_number of total_number --" marker between
    // pages by default. It carries no resume content and would otherwise be
    // parsed as an entry (a junk skill, project, or certification) downstream,
    // so the joiner is explicitly disabled.
    const result = await parser.getText({ pageJoiner: "" });

    const text = result.text ?? "";
    const lines = text.split(/\r?\n/);

    if (text.trim().length < MIN_EXTRACTED_CHARS) {
      throw new ResumeTextExtractionFailedError(
        "The PDF appears to contain no readable text (may be scanned or image-only).",
      );
    }

    return {
      text,
      charCount: text.length,
      lineCount: lines.length,
    };
  } catch (error) {
    if (error instanceof ResumeTextExtractionFailedError) {
      throw error;
    }

    throw new ResumeTextExtractionFailedError(
      "The PDF file could not be processed.",
      { cause: error },
    );
  }
}

/**
 * Extracts text from a DOCX buffer.
 *
 * Uses mammoth which extracts text from DOCX files in Node.js.
 * It preserves paragraph boundaries which helps with section detection.
 */
export async function extractDocxText(buffer: Uint8Array): Promise<ExtractedText> {
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });

    const text = result.value ?? "";
    const lines = text.split(/\r?\n/);

    if (text.trim().length < MIN_EXTRACTED_CHARS) {
      throw new ResumeTextExtractionFailedError(
        "The DOCX file appears to contain no readable text.",
      );
    }

    return {
      text,
      charCount: text.length,
      lineCount: lines.length,
    };
  } catch (error) {
    if (error instanceof ResumeTextExtractionFailedError) {
      throw error;
    }

    throw new ResumeTextExtractionFailedError(
      "The DOCX file could not be processed.",
      { cause: error },
    );
  }
}

/**
 * Extracts text from a resume file based on its extension.
 *
 * This is the main entry point for text extraction. It dispatches to
 * the appropriate format-specific extractor.
 */
export async function extractResumeText(
  buffer: Uint8Array,
  extension: ResumeFileExtension,
): Promise<ExtractedText> {
  switch (extension) {
    case "pdf":
      return extractPdfText(buffer);
    case "docx":
      return extractDocxText(buffer);
    default:
      // This should never happen because upload validation only accepts pdf/docx
      throw new ResumeTextExtractionFailedError(
        `Unsupported file format: ${extension}`,
      );
  }
}

// Re-export types for consumers
export type { ExtractedText };