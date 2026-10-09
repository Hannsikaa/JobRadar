import { describe, expect, it, vi, beforeEach } from "vitest";

import { ResumeTextExtractionFailedError } from "@/lib/resume/parser/errors";
import { extractPdfText, extractDocxText, extractResumeText } from "@/lib/resume/parser/extraction";

/**
 * Tests for document text extraction.
 *
 * These tests mock the underlying extraction libraries to test the dispatching
 * logic without requiring valid PDF/DOCX fixtures. The actual extraction
 * is tested in integration tests.
 */

// Use vi.hoisted to define mocks before imports
const { mockPdfParseInstance, MockPDFParse, mockMammothExtractRawText } = vi.hoisted(() => {
  const mockPdfParseInstance = {
    getText: vi.fn().mockResolvedValue({ text: "Extracted PDF text" }),
  };

  // Create a proper constructor function that returns the instance
  const MockPDFParse = vi.fn().mockImplementation(function() {
    return mockPdfParseInstance;
  });

  const mockMammothExtractRawText = vi.fn().mockResolvedValue({ value: "Extracted DOCX text", messages: [] });

  return { mockPdfParseInstance, MockPDFParse, mockMammothExtractRawText };
});

vi.mock("pdf-parse", () => ({
  PDFParse: MockPDFParse,
}));

vi.mock("mammoth", () => ({
  extractRawText: mockMammothExtractRawText,
}));

describe("extractPdfText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPdfParseInstance.getText.mockResolvedValue({ text: "Extracted PDF text" });
    MockPDFParse.mockImplementation(function() {
      return mockPdfParseInstance;
    });
  });

  it("extracts text from a PDF buffer", async () => {
    const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const result = await extractPdfText(buffer);

    expect(result.text).toBe("Extracted PDF text");
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.lineCount).toBeGreaterThan(0);
    // Page markers must be disabled: pdf-parse's default "-- 1 of 1 --"
    // joiner would otherwise be parsed as resume content downstream.
    expect(mockPdfParseInstance.getText).toHaveBeenCalledWith({ pageJoiner: "" });
  });

  it("throws for a PDF with no readable text", async () => {
    mockPdfParseInstance.getText.mockResolvedValue({ text: "" });

    const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46 ]);

    await expect(extractPdfText(buffer)).rejects.toBeInstanceOf(ResumeTextExtractionFailedError);
    await expect(extractPdfText(buffer)).rejects.toMatchObject({
      code: "resume_text_extraction_failed",
    });
  });

  it("throws for invalid PDF data", async () => {
    MockPDFParse.mockImplementationOnce(function() {
      throw new Error("Invalid PDF");
    });

    const buffer = new Uint8Array([0x00, 0x01, 0x02, 0x03 ]);

    await expect(extractPdfText(buffer)).rejects.toBeInstanceOf(ResumeTextExtractionFailedError);
  });
});

describe("extractDocxText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMammothExtractRawText.mockResolvedValue({ value: "Extracted DOCX text", messages: [] });
  });

  it("extracts text from a DOCX buffer", async () => {
    const buffer = new Uint8Array([0x50, 0x4b, 0x03, 0x04 ]); // ZIP signature
    const result = await extractDocxText(buffer);

    expect(result.text).toBe("Extracted DOCX text");
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("throws for a DOCX with no readable text", async () => {
    mockMammothExtractRawText.mockResolvedValue({ value: "", messages: [] });

    const buffer = new Uint8Array([0x50, 0x4b, 0x03, 0x04 ]);

    await expect(extractDocxText(buffer)).rejects.toBeInstanceOf(ResumeTextExtractionFailedError);
    await expect(extractDocxText(buffer)).rejects.toMatchObject({
      code: "resume_text_extraction_failed",
    });
  });

  it("throws for invalid DOCX data", async () => {
    mockMammothExtractRawText.mockRejectedValueOnce(new Error("Invalid DOCX"));

    const buffer = new Uint8Array([0x00, 0x01, 0x02, 0x03 ]);

    await expect(extractDocxText(buffer)).rejects.toBeInstanceOf(ResumeTextExtractionFailedError);
  });
});

describe("extractResumeText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPdfParseInstance.getText.mockResolvedValue({ text: "Extracted PDF text" });
    MockPDFParse.mockImplementation(function() {
      return mockPdfParseInstance;
    });
    mockMammothExtractRawText.mockResolvedValue({ value: "Extracted DOCX text", messages: [] });
  });

  it("dispatches to PDF extractor for pdf extension", async () => {
    const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46 ]); // %PDF
    const result = await extractResumeText(buffer, "pdf");

    expect(result.text).toBe("Extracted PDF text");
  });

  it("dispatches to DOCX extractor for docx extension", async () => {
    const buffer = new Uint8Array([0x50, 0x4b, 0x03, 0x04 ]); // ZIP signature
    const result = await extractDocxText(buffer, "docx");

    expect(result.text).toBe("Extracted DOCX text");
  });

  it("throws for unsupported extension", async () => {
    await expect(extractResumeText(new Uint8Array([0x25, 0x50, 0x44, 0x46 ]), "txt" as "pdf" | "docx")).rejects.toBeInstanceOf(ResumeTextExtractionFailedError);
  });
});