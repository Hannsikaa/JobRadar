import type { Metadata } from "next";
import Link from "next/link";

import { ResumeUpload } from "@/components/resume-upload";

export const metadata: Metadata = {
  title: "Resume",
  description:
    "Upload your resume so the workflow can parse it and run live job discovery.",
};

/**
 * Resume — the upload entry point for a fresh document.
 *
 * The file lands through the same `POST /api/resume` every upload uses, then the
 * Workflow page picks it up: parse, review, and search all read what was stored
 * here. This page is deliberately thin — it is the destination the nav promises,
 * and the workflow is where the file continues to work.
 */
export default function ResumePage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-400">
          Step one
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Upload your resume</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-zinc-400">
          Drop in a PDF or DOCX and Job Radar reads it into structured skills, experience,
          education, projects, and certifications. The{" "}
          <Link
            href="/workflow"
            className="font-medium text-emerald-400 underline-offset-4 hover:underline"
          >
            Workflow
          </Link>{" "}
          page then runs that profile against live Google Jobs results.
        </p>
      </header>

      <ResumeUpload />
    </div>
  );
}
