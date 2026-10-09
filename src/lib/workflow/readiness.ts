"use client";

import { userFetch } from "@/lib/identity/demo-user";

/**
 * The four facts about a visitor's setup, read from the server the same way for
 * every screen that needs them.
 *
 * Each flag is a fact, not an inference: `hasResume` is a stored file, `parsed`
 * is parsed content, `reviewed` is a save through Profile Review. The landing
 * page and the workflow both branch on these, so the rule for computing them
 * lives in one place rather than being re-derived per page.
 */

export type WorkflowReadiness = {
  hasResume: boolean;
  hasProfile: boolean;
  parsed: boolean;
  reviewed: boolean;
};

type ProfileSnapshot = {
  resumeFileId?: string;
  resume?: { name?: string };
  reviewedAt?: string;
};

/**
 * Reads both endpoints and folds them into the readiness flags.
 *
 * Best-effort by construction: an unreachable server or an unreadable body
 * yields the "nothing set up yet" answer, which is exactly the first-visit
 * screen. It never throws.
 */
export async function readWorkflowReadiness(): Promise<WorkflowReadiness> {
  const [profileOutcome, resumeOutcome] = await Promise.allSettled([
    userFetch("/api/profile", { cache: "no-store" }),
    userFetch("/api/resume", { cache: "no-store" }),
  ]);

  let profile: ProfileSnapshot | null = null;

  if (profileOutcome.status === "fulfilled" && profileOutcome.value.ok) {
    profile = (await profileOutcome.value.json().catch(() => null)) as ProfileSnapshot | null;
  }

  let hasStoredResume = false;

  if (resumeOutcome.status === "fulfilled" && resumeOutcome.value.ok) {
    const body = (await resumeOutcome.value.json().catch(() => null)) as {
      resume?: { id?: unknown } | null;
    } | null;

    hasStoredResume = typeof body?.resume?.id === "string" && body.resume.id.length > 0;
  }

  const parsed = typeof profile?.resume?.name === "string" && profile.resume.name.trim().length > 0;
  const reviewed = typeof profile?.reviewedAt === "string" && profile.reviewedAt.length > 0;
  const hasProfileFile =
    typeof profile?.resumeFileId === "string" && profile.resumeFileId.length > 0;

  return {
    hasResume: hasProfileFile || hasStoredResume,
    hasProfile: profile !== null,
    parsed,
    reviewed,
  };
}
