"use client";

import { useId, useRef, useState } from "react";

import { checkResumeSelection, formatFileSize } from "@/lib/resume/selection";
import { userFetch } from "@/lib/identity/demo-user";
import { MAX_RESUME_SIZE_BYTES, type ResumeFileMetadata } from "@/lib/resume/types";

/**
 * Resume upload control.
 *
 * Scope is deliberately small: pick a file, see its name and size, upload it,
 * and report what happened. There is no parsing and no resume editing here —
 * those come later and will read the file this endpoint stored.
 *
 * The browser checks in `selection.ts` only save a pointless round trip. The
 * server re-runs every one of them, so nothing in this file is a security
 * boundary.
 */

/** What the upload endpoint reports back on success. */
type UploadResponse = {
  resume: ResumeFileMetadata;
  profileLinked: boolean;
  /** Whether this upload replaced a resume the user already had. */
  replaced: boolean;
};

type UploadState =
  | { status: "idle" }
  | { status: "selected"; filename: string; size: number }
  | { status: "uploading" }
  | { status: "done"; message: string }
  | { status: "failed"; message: string };

/** Reads the API's error envelope, falling back to a generic message. */
function errorMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "The upload failed. Try again.";
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return "The upload failed. Try again.";
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0
    ? message
    : "The upload failed. Try again.";
}

/**
 * Describes the upload outcome.
 *
 * A replacement is called out separately from a first upload because it changes
 * what happens next: the profile on file was extracted from the *previous*
 * resume, so it needs re-parsing or reviewing. Saying only "uploaded" would let
 * someone carry on believing their old profile still matches what they just
 * sent.
 */
function describeUpload(profileLinked: boolean, replaced: boolean): string {
  if (replaced) {
    return profileLinked
      ? "New resume uploaded and attached to your profile. Your existing profile text came from the previous resume, so review or re-parse it."
      : "New resume uploaded, replacing the previous one.";
  }

  return profileLinked
    ? "Resume uploaded and attached to your profile."
    : "Resume uploaded. Add a profile to attach it.";
}

export function ResumeUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [dragging, setDragging] = useState(false);

  /** Applies the preliminary checks, then clears the input when one fails. */
  function selectFile(file: File): void {
    const check = checkResumeSelection(file);

    if (!check.ok) {
      setState({ status: "failed", message: check.message });
      if (inputRef.current !== null) {
        inputRef.current.value = "";
      }

      return;
    }

    setState({ status: "selected", filename: file.name, size: file.size });
  }

  async function upload(file: File): Promise<void> {
    setState({ status: "uploading" });

    // FormData rather than a JSON payload with base64: it streams the bytes and
    // avoids inflating them by a third in the request body.
    const body = new FormData();
    body.append("resume", file);

    // `userFetch` attaches this browser's stable demo id. Calling `fetch`
    // directly here — as this control used to — sent no identity at all, so
    // every upload from this screen was rejected as unattributable.
    try {
      const response = await userFetch("/api/resume", { method: "POST", body });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setState({ status: "failed", message: errorMessage(payload) });
        return;
      }

      const { profileLinked, replaced } = payload as UploadResponse;
      setState({ status: "done", message: describeUpload(profileLinked, replaced) });
    } catch {
      setState({ status: "failed", message: "The upload failed to reach the server." });
    }
  }

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file !== undefined) {
      selectFile(file);
    }
  }

  return (
    <section
      aria-labelledby="resume-upload-heading"
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-5 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id="resume-upload-heading" className="text-xl font-semibold tracking-tight text-zinc-50">
          Resume upload
        </h2>
        <p id={hintId} className="text-sm text-zinc-400">
          PDF or DOCX, up to {formatFileSize(MAX_RESUME_SIZE_BYTES)}. The file is checked on upload
          and stored under a generated name; it is parsed on the Workflow page.
        </p>
      </div>

      {/* The whole zone is the picker; the native input stays as the real
          control (it is visually hidden but still focusable via the label). */}
      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file !== undefined) {
            // Mirror the file into the input so the Upload button can re-read it.
            if (inputRef.current !== null) {
              inputRef.current.files = event.dataTransfer.files;
            }
            selectFile(file);
          }
        }}
        className={[
          "flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors",
          dragging
            ? "border-emerald-500/60 bg-emerald-500/[0.06]"
            : "border-[var(--border-strong)] bg-[var(--surface-raised)]/40 hover:border-emerald-500/40 hover:bg-[var(--surface-raised)]",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className="grid size-11 place-items-center rounded-full border border-[var(--border)] bg-black/20 text-emerald-400"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 16V4m0 0L8 8m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"
            />
          </svg>
        </span>
        <span className="text-[15px] font-semibold text-zinc-100">
          Drag a resume here, or choose a file
        </span>
        <span className="text-[13px] text-zinc-500">PDF or DOCX</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          disabled={state.status === "uploading"}
          onChange={onFileChange}
          aria-describedby={hintId}
          className="sr-only"
        />
      </label>

      {state.status === "selected" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 text-sm">
          <span className="font-medium text-zinc-100">{state.filename}</span>
          <span className="text-zinc-400">{formatFileSize(state.size)}</span>
          <button
            type="button"
            onClick={() => {
              const file = inputRef.current?.files?.[0];
              if (file !== undefined) {
                void upload(file);
              }
            }}
            className="ml-auto rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
          >
            Upload
          </button>
        </div>
      ) : null}

      {state.status === "uploading" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-amber-300">
          <span
            aria-hidden="true"
            className="size-3 animate-spin rounded-full border-2 border-amber-400/40 border-t-amber-300 motion-reduce:animate-none"
          />
          Uploading…
        </p>
      ) : null}

      {state.status === "done" ? (
        <p
          role="status"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
        >
          {state.message}
        </p>
      ) : null}

      {state.status === "failed" ? (
        <p
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300"
        >
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
