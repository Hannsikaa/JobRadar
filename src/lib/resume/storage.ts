/**
 * Binary storage for uploaded resumes.
 *
 * The app talks to {@link ResumeStorage}, not to the filesystem, so swapping the
 * local-disk adapter for object storage later touches this file and the DI
 * wiring only. The interface is deliberately small: save, read, delete. Nothing
 * here knows about MongoDB or HTTP.
 *
 * The local adapter keeps files in `.data/resumes` at the project root — outside
 * `src` and `public`, so uploads can never be served as static assets or picked
 * up by the bundler, and the whole directory is git-ignored.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ResumeStorageError,
  ResumeStorageUnavailableError,
} from "@/lib/resume/errors";
import type { ResumeFileExtension } from "@/lib/resume/types";

/** Where the local adapter writes files when no directory is supplied. */
export const DEFAULT_RESUME_STORAGE_DIR = path.join(process.cwd(), ".data", "resumes");

/**
 * The only shape a storage key may take: a generated UUID plus a known
 * extension.
 *
 * Keys are checked against this pattern *and* for path containment, because a
 * caller-supplied key is the one place a traversal bug could reach the disk.
 */
const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|docx)$/;

/** Storage operations the app needs, independent of where bytes actually live. */
export interface ResumeStorage {
  /** Writes `data` under `key`, failing if something is already stored there. */
  save(key: string, data: Uint8Array): Promise<void>;
  /** Returns the stored bytes, or `null` when nothing is stored under `key`. */
  read(key: string): Promise<Uint8Array | null>;
  /** Removes the object. Succeeds when there was nothing to remove. */
  delete(key: string): Promise<void>;
}

/** Builds the storage key for a generated id, e.g. `2f1c…-….pdf`. */
export function buildStorageKey(id: string, extension: ResumeFileExtension): string {
  return `${id}.${extension}`;
}

/** True when `key` is a well-formed, non-traversing storage key. */
export function isSafeStorageKey(key: string): boolean {
  return STORAGE_KEY_PATTERN.test(key);
}

/** Node error codes that mean "this location is not usable", not "write failed". */
const UNAVAILABLE_CODES = new Set(["EACCES", "EPERM", "ENOENT", "EROFS", "ENOTDIR"]);

/** Reads the `code` a Node system error carries, if it has one. */
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

/**
 * Maps a filesystem failure onto a safe domain error.
 *
 * Permission and read-only failures mean the deployment is not wired up, which
 * is a 503 the operator can act on. Everything else is a plain 500. The original
 * error is kept as `cause` for the server log and never returned to the caller.
 */
function toStorageError(error: unknown): ResumeStorageError | ResumeStorageUnavailableError {
  const code = errorCode(error);

  return typeof code === "string" && UNAVAILABLE_CODES.has(code)
    ? new ResumeStorageUnavailableError("The resume storage is unavailable.", { cause: error })
    : new ResumeStorageError("The resume file could not be stored.", { cause: error });
}

/**
 * Creates the local filesystem adapter.
 *
 * `root` defaults to {@link DEFAULT_RESUME_STORAGE_DIR} and is overridable so
 * tests can point at a temporary directory.
 */
export function createLocalResumeStorage(root: string = DEFAULT_RESUME_STORAGE_DIR): ResumeStorage {
  const baseDir = path.resolve(root);

  /**
   * Resolves a key to an absolute path inside `baseDir`.
   *
   * The pattern check rejects separators and `..` outright; the containment
   * check is the belt to that braces, covering anything a future change to the
   * pattern might let through.
   */
  function resolveKey(key: string): string {
    if (!isSafeStorageKey(key)) {
      throw new ResumeStorageError("The storage key is not valid.");
    }

    const resolved = path.resolve(baseDir, key);
    if (resolved !== path.join(baseDir, key)) {
      throw new ResumeStorageError("The storage key is not valid.");
    }

    return resolved;
  }

  return {
    async save(key: string, data: Uint8Array): Promise<void> {
      const target = resolveKey(key);

      try {
        await mkdir(baseDir, { recursive: true });
        // `wx` fails rather than overwriting, so a key collision can never
        // destroy a file that is already referenced by stored metadata.
        await writeFile(target, data, { flag: "wx" });
      } catch (error) {
        throw toStorageError(error);
      }
    },

    async read(key: string): Promise<Uint8Array | null> {
      const target = resolveKey(key);

      try {
        return new Uint8Array(await readFile(target));
      } catch (error) {
        // A missing object is a normal answer here, not a storage failure.
        if (errorCode(error) === "ENOENT") {
          return null;
        }

        throw toStorageError(error);
      }
    },

    async delete(key: string): Promise<void> {
      const target = resolveKey(key);

      try {
        // `force` makes deletion idempotent, which is what rollback needs.
        await rm(target, { force: true });
      } catch (error) {
        throw toStorageError(error);
      }
    },
  };
}