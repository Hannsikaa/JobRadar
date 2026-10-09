"use client";

/**
 * Profile Review — the one place a person edits their own profile.
 *
 * Three rules this page exists to enforce:
 *
 * 1. **It edits a draft, not the record.** Every keystroke updates local state
 *    only. The previous version of this page saved on every change, which meant
 *    a half-typed name overwrote a good profile, and an invalid intermediate
 *    value was a write attempt per character.
 * 2. **Nothing is written until the whole draft validates.** `PUT /api/profile`
 *    replaces both halves of the profile at once, so a partially valid draft
 *    sent as-is would destroy valid data. `validateDraft` runs the same schemas
 *    the server does and blocks the request when it fails, leaving every
 *    already-valid field untouched and on screen.
 * 3. **Both halves are always submitted.** Resume text and job preferences are
 *    one profile; sending only `resume` cannot validate, because the preferences
 *    the parser created would be replaced by schema defaults.
 *
 * It also surfaces staleness. After a resume is replaced the stored profile text
 * is kept — someone's work history is not disposable — but it no longer
 * describes the file they uploaded, and this page says so rather than letting
 * the old text pass as current.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { userFetch } from "@/lib/identity/demo-user";
import { ListInput } from "@/components/list-input";
import {
  createProfileDraft,
  toJobProfileInput,
  validateDraft,
  type ProfileDraft,
} from "@/lib/profile/review";
import { deriveProfileState, type ProfileState } from "@/lib/profile/state";
import {
  EXPERIENCE_LEVELS,
  FRESHNESS_DAY_OPTIONS,
} from "@/lib/profile/schemas";
import type { ResumeFileMetadata } from "@/lib/resume/types";
import type { StoredProfile, ValidationIssue } from "@/lib/profile/types";

/** Whether the page has data in hand, and what it is doing while getting it. */
type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      draft: ProfileDraft;
      /** Derived from the loaded data, refreshed after every successful save. */
      profileState: ProfileState;
      /** ISO time of the last successful save, or `null` before the first one. */
      savedAt: string | null;
    }
  | { status: "load-error"; message: string };

/** The outcome of the last save attempt. Kept apart from `LoadState` so a save
 *  failure never discards the draft the user is still editing. */
type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "failed"; message: string; issues: ValidationIssue[] };

const INPUT_CLASS =
  "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3.5 py-2.5 text-[15px] text-zinc-50 placeholder-zinc-500 outline-none transition-colors focus:border-emerald-500 focus-visible:outline-none focus:ring-1 focus:ring-emerald-500/60";

/** Immutable list update, so a draft change never mutates the previous state. */
function replaceAt<T>(items: readonly T[], index: number, next: T): T[] {
  return items.map((item, i) => (i === index ? next : item));
}

function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

/** Label, control, helper text, and the validation problem for that field. */
function Field({
  id,
  label,
  issue,
  hint,
  requirement,
  children,
  wide = false,
}: {
  id: string;
  label: string;
  issue?: string;
  hint?: string;
  requirement?: "required" | "optional";
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label
        htmlFor={id}
        className="mb-1.5 flex items-baseline gap-2 text-sm font-medium text-zinc-200"
      >
        {label}
        {requirement === undefined ? null : (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-500">
            ({requirement})
          </span>
        )}
      </label>
      {children}
      {hint === undefined ? null : (
        <p className="mt-1.5 text-[13px] text-zinc-500">{hint}</p>
      )}
      {issue === undefined ? null : (
        <p id={`${id}-issue`} className="mt-1.5 text-[13px] text-red-400">
          {issue}
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-5 sm:p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-zinc-50">{title}</h2>
          {description === undefined ? null : (
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3.5 py-1.5 text-sm font-medium text-zinc-100 transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
    >
      {children}
    </button>
  );
}

function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="shrink-0 rounded-full px-2.5 py-1 text-[13px] font-medium text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
    >
      Remove
    </button>
  );
}

export default function ProfileReviewPage() {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [resume, setResume] = useState<ResumeFileMetadata | null>(null);

  // Load the profile and the current resume once. The resume is a separate
  // request because "is there a resume yet" is a question about the upload
  // history, not about the profile, and answering it from the profile pointer
  // would hide the case where a file exists that the profile never linked.
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      let profile: StoredProfile | null;
      try {
        const response = await userFetch("/api/profile", {
          headers: { "cache-control": "no-store" },
        });

        if (response.status === 404) {
          // No profile is a normal first-visit state, not a failure: the page
          // exists precisely so one can be built here.
          profile = null;
        } else if (!response.ok) {
          const payload = await readErrorBody(response, "The profile could not be loaded.");
          if (!cancelled) {
            setLoad({ status: "load-error", message: payload });
          }
          return;
        } else {
          profile = (await response.json()) as StoredProfile;
        }
      } catch {
        if (!cancelled) {
          setLoad({ status: "load-error", message: "The profile could not be loaded." });
        }
        return;
      }

      let currentResume: ResumeFileMetadata | null = null;
      try {
        const response = await userFetch("/api/resume", {
          headers: { "cache-control": "no-store" },
        });
        if (response.ok) {
          const payload = (await response.json()) as { resume: ResumeFileMetadata | null };
          currentResume = payload.resume;
        }
      } catch {
        // The resume is only needed for the staleness notice. Failing to read it
        // must not block editing a profile that loaded fine, so the notice falls
        // back to comparing the profile's own pointers.
        currentResume = null;
      }

      if (cancelled) {
        return;
      }

      setResume(currentResume);
      setLoad({
        status: "ready",
        draft: createProfileDraft(profile),
        profileState: deriveProfileState({ profile, resume: currentResume }),
        savedAt: null,
      });
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  /** Applies a draft change locally. No request is made. */
  const edit = useCallback((update: (draft: ProfileDraft) => ProfileDraft) => {
    setLoad((current) => (current.status === "ready" ? { ...current, draft: update(current.draft) } : current));
    // A new edit invalidates the previous attempt's complaint; leaving it up
    // would point at a field the user has already fixed.
    setSave({ status: "idle" });
  }, []);

  const editResume = useCallback(
    (update: (resume: ProfileDraft["resume"]) => ProfileDraft["resume"]) => {
      edit((draft) => ({ ...draft, resume: update(draft.resume) }));
    },
    [edit],
  );

  const editPreferences = useCallback(
    (update: (preferences: ProfileDraft["preferences"]) => ProfileDraft["preferences"]) => {
      edit((draft) => ({ ...draft, preferences: update(draft.preferences) }));
    },
    [edit],
  );

  /**
   * Validates the whole draft, then writes it.
   *
   * Both steps are ordered so that a rejected draft never reaches the database
   * and a rejected request never clears the form.
   */
  const handleSave = useCallback(async () => {
    if (load.status !== "ready") {
      return;
    }

    const validated = validateDraft(load.draft);
    if (!validated.ok) {
      setSave({
        status: "failed",
        message: "Fix the problems below before saving. Nothing has been changed.",
        issues: validated.issues,
      });
      return;
    }

    setSave({ status: "saving" });

    try {
      const response = await userFetch("/api/profile", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify(toJobProfileInput(load.draft)),
      });

      if (!response.ok) {
        const issues = await readValidationIssues(response);
        setSave({
          status: "failed",
          // The draft is left exactly as the user left it. A rejected save is a
          // complaint about the input, not a reason to discard it.
          message: issues.length > 0
            ? "The profile could not be saved. Fix the problems below — nothing has been changed."
            : "The profile could not be saved. Your edits are still here.",
          issues,
        });
        return;
      }

      const saved = (await response.json()) as StoredProfile;
      setLoad({
        status: "ready",
        // Rebuilt from the server's normalized copy so the form shows exactly
        // what was stored — trimmed, deduplicated, defaults applied.
        draft: createProfileDraft(saved),
        profileState: deriveProfileState({ profile: saved, resume }),
        savedAt: new Date().toISOString(),
      });
      setSave({ status: "idle" });
      router.push("/workflow");
    } catch {
      setSave({
        status: "failed",
        message: "The profile could not be saved. Your edits are still here.",
        issues: [],
      });
    }
  }, [load, resume, router]);

  if (load.status === "loading") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-zinc-400" role="status">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent motion-reduce:animate-none" />
          <p className="text-sm">Loading profile…</p>
        </div>
      </div>
    );
  }

  if (load.status === "load-error") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <p role="alert" className="text-[15px] text-red-400">
            {load.message}
          </p>
          <button
            type="button"
            onClick={() => router.push("/workflow")}
            className="rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:text-zinc-50"
          >
            Back to Workflow
          </button>
        </div>
      </div>
    );
  }

  const { draft, profileState } = load;
  const resumeProfile = draft.resume;
  const preferences = draft.preferences;

  /** The problem reported for a path, or `undefined` when that path is fine. */
  const issueFor = (path: string): string | undefined =>
    save.status === "failed" ? save.issues.find((issue) => issue.path === path)?.message : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-400">
            Profile
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Review Profile</h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-zinc-400">
            Check what was extracted from your resume, set what you are looking for, then continue.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {save.status === "saving" ? (
            <span className="text-sm text-zinc-400" role="status">
              Saving…
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => router.push("/workflow")}
            className="rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:text-zinc-50"
          >
            Back to Workflow
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={save.status === "saving"}
            className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
          >
            {save.status === "saving" ? "Saving…" : "Save & Continue"}
          </button>
        </div>
      </div>

      <ProfileNotice state={profileState} resume={resume} />

      {save.status === "failed" ? (
        <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/[0.07] p-4">
          <p className="text-sm text-red-300">{save.message}</p>
          {save.issues.length === 0 ? null : (
            <ul className="mt-2 list-disc pl-5 text-[13px] text-red-300/90">
              {save.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  {issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <Section title="About you" description="How you want to appear in job search results.">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              id="name"
              label="Name"
              issue={issueFor("resume.name")}
              requirement="required"
            >
              <input
                id="name"
                type="text"
                value={resumeProfile.name}
                onChange={(event) => editResume((current) => ({ ...current, name: event.target.value }))}
                className={INPUT_CLASS}
                placeholder="Your name"
              />
            </Field>
            <Field
              id="headline"
              label="Headline"
              issue={issueFor("resume.headline")}
              requirement="optional"
            >
              <input
                id="headline"
                type="text"
                value={resumeProfile.headline ?? ""}
                onChange={(event) =>
                  editResume((current) => ({ ...current, headline: event.target.value }))
                }
                className={INPUT_CLASS}
                placeholder="Senior Backend Engineer"
              />
            </Field>
            <Field
              id="location"
              label="Location"
              issue={issueFor("resume.location")}
              requirement="optional"
            >
              <input
                id="location"
                type="text"
                value={resumeProfile.location ?? ""}
                onChange={(event) =>
                  editResume((current) => ({ ...current, location: event.target.value }))
                }
                className={INPUT_CLASS}
                placeholder="Berlin, Germany"
              />
            </Field>
            <Field
              id="languages"
              label="Languages"
              issue={issueFor("resume.languages")}
              requirement="optional"
              hint="Separate entries with commas."
            >
              <ListInput
                id="languages"
                value={resumeProfile.languages}
                onChange={(next) => editResume((current) => ({ ...current, languages: next }))}
                className={INPUT_CLASS}
                placeholder="English, Spanish, Hindi"
              />
            </Field>
            <Field
              id="summary"
              label="Summary"
              issue={issueFor("resume.summary")}
              requirement="optional"
              wide
            >
              <textarea
                id="summary"
                rows={3}
                value={resumeProfile.summary ?? ""}
                onChange={(event) =>
                  editResume((current) => ({ ...current, summary: event.target.value }))
                }
                className={INPUT_CLASS}
                placeholder="A short description of your experience and what you are after."
              />
            </Field>
            <Field
              id="skills"
              label="Skills"
              issue={issueFor("resume.skills")}
              requirement="optional"
              hint="Separate entries with commas."
              wide
            >
              <ListInput
                id="skills"
                value={resumeProfile.skills}
                onChange={(next) => editResume((current) => ({ ...current, skills: next }))}
                className={INPUT_CLASS}
                placeholder="TypeScript, MongoDB, React"
              />
            </Field>
          </div>
        </Section>

        <Section
          title="What you're looking for"
          description="These drive job search. Leaving the roles empty is fine until you decide."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              id="target-roles"
              label="Target roles"
              issue={issueFor("preferences.targetRoles")}
              requirement="optional"
              hint="Separate entries with commas, e.g. Python Backend Developer, AI Engineer."
              wide
            >
              <ListInput
                id="target-roles"
                value={preferences.targetRoles}
                onChange={(next) =>
                  editPreferences((current) => ({ ...current, targetRoles: next }))
                }
                className={INPUT_CLASS}
                placeholder="Backend Engineer, Platform Engineer"
              />
            </Field>
            <Field
              id="locations"
              label="Locations"
              issue={issueFor("preferences.locations")}
              requirement="optional"
              hint="City names, or worldwide / remote phrases. Separate entries with commas."
              wide
            >
              <ListInput
                id="locations"
                value={preferences.locations}
                onChange={(next) => editPreferences((current) => ({ ...current, locations: next }))}
                className={INPUT_CLASS}
                placeholder="Berlin, Remote in Europe"
              />
            </Field>
            <Field
              id="experience-level"
              label="Experience level"
              issue={issueFor("preferences.experienceLevel")}
              requirement="optional"
            >
              <select
                id="experience-level"
                value={preferences.experienceLevel}
                onChange={(event) =>
                  editPreferences((current) => ({
                    ...current,
                    experienceLevel: event.target.value as typeof current.experienceLevel,
                  }))
                }
                className={INPUT_CLASS}
              >
                {EXPERIENCE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="freshness-days"
              label="Postings newer than"
              issue={issueFor("preferences.freshnessDays")}
              requirement="optional"
            >
              <select
                id="freshness-days"
                value={preferences.freshnessDays}
                onChange={(event) =>
                  editPreferences((current) => ({
                    ...current,
                    freshnessDays: Number(event.target.value) as typeof current.freshnessDays,
                  }))
                }
                className={INPUT_CLASS}
              >
                {FRESHNESS_DAY_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    {days} {days === 1 ? "day" : "days"}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="minimum-salary"
              label="Minimum salary"
              issue={issueFor("preferences.minimumSalary")}
              requirement="optional"
            >
              <input
                id="minimum-salary"
                type="number"
                min={0}
                value={preferences.minimumSalary ?? ""}
                onChange={(event) =>
                  editPreferences((current) => ({
                    ...current,
                    minimumSalary:
                      event.target.value === "" ? undefined : Number(event.target.value),
                  }))
                }
                className={INPUT_CLASS}
                placeholder="No minimum"
              />
            </Field>
            <Field
              id="salary-currency"
              label="Salary currency"
              issue={issueFor("preferences.salaryCurrency")}
              requirement="optional"
            >
              <input
                id="salary-currency"
                type="text"
                value={preferences.salaryCurrency ?? ""}
                onChange={(event) =>
                  editPreferences((current) => ({
                    ...current,
                    // An empty box means "not set", and an empty string is not a
                    // valid currency — the schema rejects blank values.
                    salaryCurrency: event.target.value === "" ? undefined : event.target.value,
                  }))
                }
                className={INPUT_CLASS}
                placeholder="EUR"
              />
            </Field>
            <div className="flex items-center pt-1">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={preferences.remoteOnly}
                  onChange={(event) =>
                    editPreferences((current) => ({
                      ...current,
                      remoteOnly: event.target.checked,
                    }))
                  }
                  className="size-4 rounded border-[var(--border-strong)] bg-[var(--surface-raised)] text-emerald-500 focus:ring-emerald-500"
                />
                Remote only
              </label>
            </div>
          </div>
        </Section>

        <Section
          title="Experience"
          action={
            <AddButton
              onClick={() =>
                editResume((current) => ({
                  ...current,
                  experience: [
                    ...current.experience,
                    { company: "", title: "", currentlyWorking: false },
                  ],
                }))
              }
            >
              + Add Experience
            </AddButton>
          }
        >
          {resumeProfile.experience.length === 0 ? (
            <p className="text-sm text-zinc-400">No experience entries yet.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {resumeProfile.experience.map((experience, index) => (
                <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)]/60 p-4 sm:p-5">
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <h3 className="text-[15px] font-semibold text-zinc-100">Experience #{index + 1}</h3>
                    <RemoveButton
                      label={`Remove experience ${index + 1}`}
                      onClick={() =>
                        editResume((current) => ({
                          ...current,
                          experience: removeAt(current.experience, index),
                        }))
                      }
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field
                      id={`exp-title-${index}`}
                      label="Title"
                      issue={issueFor(`resume.experience.${index}.title`)}
                    >
                      <input
                        id={`exp-title-${index}`}
                        type="text"
                        value={experience.title}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            experience: replaceAt(current.experience, index, {
                              ...experience,
                              title: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`exp-company-${index}`}
                      label="Company"
                      issue={issueFor(`resume.experience.${index}.company`)}
                    >
                      <input
                        id={`exp-company-${index}`}
                        type="text"
                        value={experience.company}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            experience: replaceAt(current.experience, index, {
                              ...experience,
                              company: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`exp-location-${index}`}
                      label="Location"
                      issue={issueFor(`resume.experience.${index}.location`)}
                    >
                      <input
                        id={`exp-location-${index}`}
                        type="text"
                        value={experience.location ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            experience: replaceAt(current.experience, index, {
                              ...experience,
                              location: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`exp-start-${index}`}
                      label="Start date"
                      issue={issueFor(`resume.experience.${index}.startDate`)}
                    >
                      <input
                        id={`exp-start-${index}`}
                        type="text"
                        value={experience.startDate ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            experience: replaceAt(current.experience, index, {
                              ...experience,
                              startDate: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                        placeholder="2021-03"
                      />
                    </Field>
                    <Field
                      id={`exp-end-${index}`}
                      label="End date"
                      issue={issueFor(`resume.experience.${index}.endDate`)}
                    >
                      <input
                        id={`exp-end-${index}`}
                        type="text"
                        value={experience.endDate ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            experience: replaceAt(current.experience, index, {
                              ...experience,
                              endDate: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                        placeholder="Present"
                      />
                    </Field>
                    <div className="flex items-end">
                      <label className="flex items-center gap-2 text-sm text-zinc-300">
                        <input
                          type="checkbox"
                          checked={experience.currentlyWorking}
                          onChange={(event) =>
                            editResume((current) => ({
                              ...current,
                              experience: replaceAt(current.experience, index, {
                                ...experience,
                                currentlyWorking: event.target.checked,
                              }),
                            }))
                          }
                          className="size-4 rounded border-[var(--border-strong)] bg-[var(--surface-raised)] text-emerald-500 focus:ring-emerald-500"
                        />
                        Currently working here
                      </label>
                    </div>
                    <Field
                      id={`exp-description-${index}`}
                      label="Description"
                      issue={issueFor(`resume.experience.${index}.description`)}
                      wide
                    >
                      <textarea
                        id={`exp-description-${index}`}
                        rows={3}
                        value={experience.description ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            experience: replaceAt(current.experience, index, {
                              ...experience,
                              description: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Education"
          action={
            <AddButton
              onClick={() =>
                editResume((current) => ({
                  ...current,
                  education: [
                    ...current.education,
                    { school: "", degree: "", currentlyStudying: false },
                  ],
                }))
              }
            >
              + Add Education
            </AddButton>
          }
        >
          {resumeProfile.education.length === 0 ? (
            <p className="text-sm text-zinc-400">No education entries yet.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {resumeProfile.education.map((education, index) => (
                <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)]/60 p-4 sm:p-5">
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <h3 className="text-[15px] font-semibold text-zinc-100">Education #{index + 1}</h3>
                    <RemoveButton
                      label={`Remove education ${index + 1}`}
                      onClick={() =>
                        editResume((current) => ({
                          ...current,
                          education: removeAt(current.education, index),
                        }))
                      }
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field
                      id={`edu-school-${index}`}
                      label="School"
                      issue={issueFor(`resume.education.${index}.school`)}
                    >
                      <input
                        id={`edu-school-${index}`}
                        type="text"
                        value={education.school}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            education: replaceAt(current.education, index, {
                              ...education,
                              school: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`edu-degree-${index}`}
                      label="Degree"
                      issue={issueFor(`resume.education.${index}.degree`)}
                    >
                      <input
                        id={`edu-degree-${index}`}
                        type="text"
                        value={education.degree}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            education: replaceAt(current.education, index, {
                              ...education,
                              degree: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`edu-field-${index}`}
                      label="Field of study"
                      issue={issueFor(`resume.education.${index}.fieldOfStudy`)}
                    >
                      <input
                        id={`edu-field-${index}`}
                        type="text"
                        value={education.fieldOfStudy ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            education: replaceAt(current.education, index, {
                              ...education,
                              fieldOfStudy: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`edu-start-year-${index}`}
                      label="Start year"
                      issue={issueFor(`resume.education.${index}.startYear`)}
                    >
                      <input
                        id={`edu-start-year-${index}`}
                        type="number"
                        value={education.startYear ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            education: replaceAt(current.education, index, {
                              ...education,
                              startYear: toOptionalNumber(event.target.value),
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`edu-end-year-${index}`}
                      label="End year"
                      issue={issueFor(`resume.education.${index}.endYear`)}
                    >
                      <input
                        id={`edu-end-year-${index}`}
                        type="number"
                        value={education.endYear ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            education: replaceAt(current.education, index, {
                              ...education,
                              endYear: toOptionalNumber(event.target.value),
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <div className="flex items-end">
                      <label className="flex items-center gap-2 text-sm text-zinc-300">
                        <input
                          type="checkbox"
                          checked={education.currentlyStudying}
                          onChange={(event) =>
                            editResume((current) => ({
                              ...current,
                              education: replaceAt(current.education, index, {
                                ...education,
                                currentlyStudying: event.target.checked,
                              }),
                            }))
                          }
                          className="size-4 rounded border-[var(--border-strong)] bg-[var(--surface-raised)] text-emerald-500 focus:ring-emerald-500"
                        />
                        Currently studying
                      </label>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Projects"
          action={
            <AddButton
              onClick={() =>
                editResume((current) => ({
                  ...current,
                  projects: [...current.projects, { name: "", technologies: [] }],
                }))
              }
            >
              + Add Project
            </AddButton>
          }
        >
          {resumeProfile.projects.length === 0 ? (
            <p className="text-sm text-zinc-400">No projects yet.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {resumeProfile.projects.map((project, index) => (
                <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)]/60 p-4 sm:p-5">
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <h3 className="text-[15px] font-semibold text-zinc-100">Project #{index + 1}</h3>
                    <RemoveButton
                      label={`Remove project ${index + 1}`}
                      onClick={() =>
                        editResume((current) => ({
                          ...current,
                          projects: removeAt(current.projects, index),
                        }))
                      }
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field
                      id={`project-name-${index}`}
                      label="Name"
                      issue={issueFor(`resume.projects.${index}.name`)}
                    >
                      <input
                        id={`project-name-${index}`}
                        type="text"
                        value={project.name}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            projects: replaceAt(current.projects, index, {
                              ...project,
                              name: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`project-link-${index}`}
                      label="Link"
                      issue={issueFor(`resume.projects.${index}.link`)}
                    >
                      <input
                        id={`project-link-${index}`}
                        type="url"
                        value={project.link ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            projects: replaceAt(current.projects, index, {
                              ...project,
                              link: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                        placeholder="https://github.com/you/project"
                      />
                    </Field>
                    <Field
                      id={`project-technologies-${index}`}
                      label="Technologies"
                      issue={issueFor(`resume.projects.${index}.technologies`)}
                      hint="Separate entries with commas."
                      wide
                    >
                      <ListInput
                        id={`project-technologies-${index}`}
                        value={project.technologies}
                        onChange={(next) =>
                          editResume((current) => ({
                            ...current,
                            projects: replaceAt(current.projects, index, {
                              ...project,
                              technologies: next,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                        placeholder="React, tRPC, Postgres"
                      />
                    </Field>
                    <Field
                      id={`project-description-${index}`}
                      label="Description"
                      issue={issueFor(`resume.projects.${index}.description`)}
                      wide
                    >
                      <textarea
                        id={`project-description-${index}`}
                        rows={3}
                        value={project.description ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            projects: replaceAt(current.projects, index, {
                              ...project,
                              description: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Certifications"
          action={
            <AddButton
              onClick={() =>
                editResume((current) => ({
                  ...current,
                  certifications: [...current.certifications, { name: "", issuer: "" }],
                }))
              }
            >
              + Add Certification
            </AddButton>
          }
        >
          {resumeProfile.certifications.length === 0 ? (
            <p className="text-sm text-zinc-400">No certifications yet.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {resumeProfile.certifications.map((certification, index) => (
                <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)]/60 p-4 sm:p-5">
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <h3 className="text-[15px] font-semibold text-zinc-100">Certification #{index + 1}</h3>
                    <RemoveButton
                      label={`Remove certification ${index + 1}`}
                      onClick={() =>
                        editResume((current) => ({
                          ...current,
                          certifications: removeAt(current.certifications, index),
                        }))
                      }
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field
                      id={`certification-name-${index}`}
                      label="Name"
                      issue={issueFor(`resume.certifications.${index}.name`)}
                    >
                      <input
                        id={`certification-name-${index}`}
                        type="text"
                        value={certification.name}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            certifications: replaceAt(current.certifications, index, {
                              ...certification,
                              name: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`certification-issuer-${index}`}
                      label="Issuer"
                      issue={issueFor(`resume.certifications.${index}.issuer`)}
                    >
                      <input
                        id={`certification-issuer-${index}`}
                        type="text"
                        value={certification.issuer}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            certifications: replaceAt(current.certifications, index, {
                              ...certification,
                              issuer: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`certification-date-${index}`}
                      label="Date"
                      issue={issueFor(`resume.certifications.${index}.date`)}
                    >
                      <input
                        id={`certification-date-${index}`}
                        type="text"
                        value={certification.date ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            certifications: replaceAt(current.certifications, index, {
                              ...certification,
                              date: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                        placeholder="2023-11"
                      />
                    </Field>
                    <Field
                      id={`certification-credential-${index}`}
                      label="Credential ID"
                      issue={issueFor(`resume.certifications.${index}.credentialId`)}
                    >
                      <input
                        id={`certification-credential-${index}`}
                        type="text"
                        value={certification.credentialId ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            certifications: replaceAt(current.certifications, index, {
                              ...certification,
                              credentialId: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field
                      id={`certification-link-${index}`}
                      label="Credential URL"
                      issue={issueFor(`resume.certifications.${index}.link`)}
                      wide
                    >
                      <input
                        id={`certification-link-${index}`}
                        type="url"
                        value={certification.link ?? ""}
                        onChange={(event) =>
                          editResume((current) => ({
                            ...current,
                            certifications: replaceAt(current.certifications, index, {
                              ...certification,
                              link: event.target.value,
                            }),
                          }))
                        }
                        className={INPUT_CLASS}
                        placeholder="https://example.com/verify"
                      />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

/** Empty numeric input means "not provided", not zero. */
function toOptionalNumber(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}

/**
 * The staleness notice.
 *
 * Says plainly which of the two situations applies, because "some of this
 * information may be out of date" is not actionable. A resume replaced since the
 * last parse is a different instruction from "nobody has reviewed this yet".
 */
function ProfileNotice({
  state,
  resume,
}: {
  state: ProfileState;
  resume: ResumeFileMetadata | null;
}) {
  if (!state.hasProfile) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
        {state.hasResume
          ? "Your resume has not been turned into a profile yet. Fill this in and save, or re-parse the resume from the workflow."
          : "No profile yet. Fill this in to create one."}
      </div>
    );
  }

  if (state.resumeChangedSinceParse) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
        {resume === null
          ? "This profile was extracted from a resume that is no longer on file."
          : `This profile was extracted from an earlier version of ${resume.originalFilename}. Review it against your current resume before continuing — nothing here has been deleted.`}
      </div>
    );
  }

  if (!state.profileReviewed) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-4 text-sm text-zinc-300">
        This profile came straight from your resume and nobody has checked it yet. Correct anything
        that looks wrong, then save.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">
      Your profile is up to date with your resume and saved. Changes here take effect when you
      continue.
    </div>
  );
}

/** Reads a failed response's envelope, falling back to a fixed sentence. */
async function readErrorBody(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;

  return payload?.error?.message ?? fallback;
}

/**
 * Reads the field-level problems from a rejected save.
 *
 * Both halves of the profile are validated against the same schemas here and on
 * the server, so a client-side catch and a server response describe problems in
 * the same shape and one renderer handles both.
 */
async function readValidationIssues(response: Response): Promise<ValidationIssue[]> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { issues?: ValidationIssue[] };
  } | null;

  return Array.isArray(payload?.error?.issues) ? payload.error.issues : [];
}