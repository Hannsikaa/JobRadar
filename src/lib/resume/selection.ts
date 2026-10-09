/**
 * Client-safe checks for a chosen resume file.
 *
 * The browser can tell us a file's name, type, and size before uploading, and
 * rejecting obvious mistakes here saves the user a pointless round trip. This
 * is a *preliminary* filter only: everything it checks is re-verified on the
 * server, because a client-supplied check proves nothing.
 *
 * The module depends on nothing but the shared constants in `types.ts`, so it can
 * run in the browser and under Vitest alike.
 */

import {
  MAX_RESUME_SIZE_BYTES,
  RESUME_EXTENSIONS,
  RESUME_MIME_TYPES,
  type ResumeFileExtension,
} from "@/lib/resume/types";

/** The subset of `File` these checks need, so plain objects work in tests. */
export type SelectedFileLike = {
  name: string;
  size: number;
  type: string;
};

/** Why a selected file cannot be uploaded, or that it passed. */
export type ResumeSelectionResult =
  | { ok: true; extension: ResumeFileExtension }
  | { ok: false; message: string };

/** Lower-cased extension without the dot, or `null` when there is none. */
function fileExtension(filename: string): string | null {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  if (dot <= 0 || dot === base.length - 1) {
    return null;
  }

  return base.slice(dot + 1).toLowerCase();
}

/**
 * Resolves the format of a file from its name and declared MIME type.
 *
 * Both must agree: a `.pdf` sent as `application/vnd.openxmlformats...` is a
 * mismatch and is refused rather than trusted. An empty `type` is common in the
 * wild for less popular formats, but DOCX always arrives with a real MIME type,
 * so a blank type is treated as a mismatch instead of a free pass.
 */
export function resolveResumeExtension(file: SelectedFileLike): ResumeFileExtension | null {
  const extension = fileExtension(file.name);

  if (extension === null) {
    return null;
  }

  const expectedMime = RESUME_MIME_TYPES[extension as ResumeFileExtension];
  if (expectedMime === undefined || file.type.toLowerCase() !== expectedMime) {
    return null;
  }

  return extension as ResumeFileExtension;
}

/** Formats a byte count as a short human-readable size, e.g. `1.4 MB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Validates a selected file before upload.
 *
 * Size is checked before the format so an oversized file is rejected on its
 * size alone, and an empty file is refused early rather than uploaded to be
 * rejected later.
 */
export function checkResumeSelection(file: SelectedFileLike): ResumeSelectionResult {
  if (file.size <= 0) {
    return { ok: false, message: "That file is empty. Choose a PDF or DOCX with content." };
  }

  if (file.size > MAX_RESUME_SIZE_BYTES) {
    return {
      ok: false,
      message: `That file is ${formatFileSize(file.size)}. The limit is ${formatFileSize(MAX_RESUME_SIZE_BYTES)}.`,
    };
  }

  const extension = resolveResumeExtension(file);
  if (extension === null) {
    return {
      ok: false,
      message: `Only ${RESUME_EXTENSIONS.join(" and ").toUpperCase()} files are accepted.`,
    };
  }

  return { ok: true, extension };
}