"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { checkResumeSelection, formatFileSize } from "@/lib/resume/selection";
import { MAX_RESUME_SIZE_BYTES, type ResumeFileMetadata } from "@/lib/resume/types";
import { userFetch } from "@/lib/identity/demo-user";

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (filename: string, fileId: string) => void;
}

type UploadState =
  | { status: "idle" }
  | { status: "selected"; file: File }
  | { status: "uploading" }
  | { status: "done"; filename: string }
  | { status: "failed"; message: string };

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

export function UploadModal({ isOpen, onClose, onComplete }: UploadModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ status: "idle" });

  // Escape closes the dialog, and the page behind it does not scroll while a
  // modal is open — the two things a dialog is expected to do and this one did
  // not.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  const selectFile = useCallback((file: File) => {
    const check = checkResumeSelection(file);
    if (!check.ok) {
      setState({ status: "failed", message: check.message });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setState({ status: "selected", file });
  }, []);

  const upload = useCallback(async (file: File) => {
    setState({ status: "uploading" });
    const body = new FormData();
    body.append("resume", file);

    try {
      const response = await userFetch("/api/resume", {
        method: "POST",
        body,
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setState({ status: "failed", message: errorMessage(payload) });
        return;
      }

      const { resume } = (payload as { resume: ResumeFileMetadata; profileLinked: boolean });
      setState({ status: "done", filename: resume.originalFilename });
      onComplete(resume.originalFilename, resume.id);
    } catch {
      setState({ status: "failed", message: "The upload failed to reach the server." });
    }
  }, [onComplete]);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) selectFile(file);
    },
    [selectFile]
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const file = event.dataTransfer.files[0];
      if (file) selectFile(file);
    },
    [selectFile]
  );

  const handleRemove = useCallback(() => {
    setState({ status: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="jr-rise relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 id="upload-modal-title" className="text-xl font-semibold tracking-tight text-zinc-50">
            Upload resume
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
            aria-label="Close upload modal"
          >
            <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {state.status === "idle" && (
          <div
            className="relative rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised)]/50 p-8 text-center transition-colors hover:border-emerald-500/40"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="absolute inset-0 size-full cursor-pointer opacity-0"
              onChange={handleFileChange}
              aria-label="Choose resume file"
            />
            <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full border border-[var(--border)] bg-black/20 text-emerald-400">
              <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M12 16V4m0 0L8 8m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
              </svg>
            </span>
            <p className="font-medium text-zinc-100">Drag and drop your resume</p>
            <p className="mt-1 text-sm text-zinc-400">or click to browse</p>
            <p className="mt-3 text-[13px] text-zinc-500">
              PDF or DOCX · up to {formatFileSize(MAX_RESUME_SIZE_BYTES)}
            </p>
          </div>
        )}

        {state.status === "selected" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4">
              <svg className="size-8 shrink-0 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-zinc-100">{state.file.name}</p>
                <p className="text-[13px] text-zinc-500">{formatFileSize(state.file.size)}</p>
              </div>
              <button
                type="button"
                onClick={handleRemove}
                className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
                aria-label="Remove file"
              >
                <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              onClick={() => upload(state.file)}
              className="w-full rounded-full bg-emerald-500 px-4 py-2.5 font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
            >
              Upload resume
            </button>
          </div>
        )}

        {state.status === "uploading" && (
          <div className="flex flex-col items-center gap-4 py-4" role="status">
            <div
              className="size-10 animate-spin rounded-full border-2 border-[var(--border)] border-t-emerald-400 motion-reduce:animate-none"
              aria-hidden="true"
            />
            <p className="text-zinc-300">Uploading…</p>
          </div>
        )}

        {state.status === "done" && (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <div className="grid size-14 place-items-center rounded-full bg-emerald-500/20">
              <svg className="size-7 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-zinc-100">Upload complete</p>
              <p className="font-mono text-sm text-emerald-300">{state.filename}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-full bg-emerald-500 px-4 py-2.5 font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
            >
              Continue
            </button>
          </div>
        )}

        {state.status === "failed" && (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <div className="grid size-14 place-items-center rounded-full bg-red-500/20">
              <svg className="size-7 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-sm text-red-300">{state.message}</p>
            <button
              type="button"
              onClick={handleRemove}
              className="w-full rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-2.5 font-medium text-zinc-100 transition-colors hover:text-zinc-50"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
