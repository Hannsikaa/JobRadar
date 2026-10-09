"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { UploadModal } from "@/components/upload-modal";
import { WorkflowGraph } from "@/components/workflow-graph";
import { PlayIcon } from "@/components/workflow-icons";
import { userFetch } from "@/lib/identity/demo-user";
import type { WorkflowReadiness } from "@/lib/workflow/readiness";
import {
  describeBlockers,
  emptySnapshot,
  invalidateFrom,
  withStage,
  type DiscoveryStage,
  type WorkflowNodeStatus,
  type WorkflowSnapshot,
  type WorkflowStage,
} from "@/lib/workflow/state";

/**
 * The workflow: real resume upload, real parsing, real profile navigation, and
 * a status surface for the stages this chat does not own.
 *
 * Every status here comes from a real request. There is no timer in this file —
 * nothing advances a stage on its own, and a failure is shown as a failure
 * rather than papered over with a green tick.
 *
 * The three discovery stages (SerpApi, Process, Job Matches) are represented but
 * never driven from here: `onRunDiscovery` is the integration point for whoever
 * builds the job-search pipeline. Until something is wired into it, Start
 * Workflow is disabled and says so, instead of pretending a run began.
 */

/** Lets the discovery runner report what actually happened to a stage. */
export type DiscoveryReport = {
  setStage: (
    stage: DiscoveryStage,
    status: WorkflowNodeStatus,
    options?: { detail?: string; error?: string }
  ) => void;
};

/**
 * Runs the job-search half of the pipeline.
 *
 * Contract: set a stage to `processing` before its request starts, and to
 * `completed` or `failed` when it settles. The workflow never fills these in on
 * the runner's behalf, so a runner that reports nothing leaves the nodes as they
 * were.
 *
 * The restore runner is the one exception to the "processing first" half: it
 * reads state that already exists rather than performing work, so it either
 * reports the stages of the scan it restored or reports nothing at all. It must
 * never claim progress on a request that has not happened.
 */
export type DiscoveryRunner = (report: DiscoveryReport) => Promise<void>;

/**
 * What the server actually reported about this visitor, in four honest flags.
 *
 * Lifted to the page so it can point at the right next action. The type itself
 * lives in `@/lib/workflow/readiness` so the landing page and the workflow read
 * the same facts the same way; it is re-exported here because this module is
 * where consumers already import it from.
 *
 * Each flag is a fact, not an inference: `hasResume` is a stored file, `parsed`
 * is parsed content, `reviewed` is a save through Profile Review.
 */
export type { WorkflowReadiness };

export type WorkflowProps = {
  /** Supplied by the job-search implementation. Absent until then. */
  onRunDiscovery?: DiscoveryRunner;
  /**
   * Reports the server-backed readiness flags whenever they are (re)read, so a
   * parent can adapt its first screen without a second source of truth.
   */
  onReadinessChange?: (readiness: WorkflowReadiness) => void;
  /**
   * Runs once on mount, so a page refresh can restore the stages a previous
   * real run completed instead of collapsing to an idle workflow over results
   * that are still shown — or worse, over results that were lost.
   *
   * Like `onRunDiscovery`, every stage it sets comes from something that
   * genuinely happened; unlike it, this is a read, so it never flips a node to
   * `processing` and never sets `running`.
   */
  onRestoreDiscovery?: DiscoveryRunner;
  /**
   * Called when an upstream input changed so the pipeline tail stopped being
   * true — a replaced resume, a re-parse. The discovery stages reset to idle
   * either way; whoever rendered the previous run's results uses this to drop
   * them too, so the screen never shows a scan that the server would already
   * refuse to restore.
   */
  onDiscoveryInvalidated?: () => void;
};

/** The parts of `GET /api/profile` the workflow reads. */
type ProfileSnapshot = {
  resumeFileId?: string;
  updatedAt?: string;
  resume?: { name?: string };
  /**
   * Stamped by `PUT /api/profile`, cleared whenever a new parse replaces the
   * text it refers to. This is the review stage's real server-side marker.
   */
  reviewedAt?: string;
};

/** What is known about the stored resume, as reported by the server. */
type ResumeFacts = {
  fileId: string | null;
  /** `GET /api/resume`'s filename when there is one, else this tab's upload. */
  filename: string | null;
};

/** The parts of `GET /api/resume` the workflow reads. */
type StoredResume = {
  id: string;
  originalFilename: string;
};

/**
 * Every fact the workflow projects onto its first three nodes.
 *
 * Two endpoints, because neither one answers every question: the resume endpoint
 * knows whether a file exists and what it is called, and the profile endpoint
 * knows whether that file has been parsed. Reading only the profile would make a
 * resume that has not been parsed yet look like no resume at all — the file is
 * on the server, the node would say otherwise.
 */
export type ServerFacts = {
  /** `GET /api/profile`, or `null` when the user has no profile yet. */
  profile: ProfileSnapshot | null;
  /** `GET /api/resume`, or `null` when no resume is stored. */
  resume: StoredResume | null;
  /** Filename known from an upload this tab performed, which wins over both. */
  filename: string | null;
};

/** Outcome of reading the stored profile, before it is applied to any state. */
type ProfileRead =
  | { kind: "missing" }
  | { kind: "unreadable"; message: string }
  | { kind: "profile"; profile: ProfileSnapshot };

/**
 * Reads the stored profile.
 *
 * Returns a value rather than setting state, so the caller decides when to apply
 * it. Keeping the fetch separate from the state write is what lets the initial
 * load start in an effect without the effect body itself setting state.
 */
async function readStoredProfile(): Promise<ProfileRead> {
  let response: Response;

  try {
    response = await userFetch("/api/profile", { cache: "no-store" });
  } catch {
    return { kind: "unreadable", message: "Could not reach the server to load your saved state." };
  }

  // No profile is the normal first-run state, not a failure.
  if (response.status === 404) {
    return { kind: "missing" };
  }

  if (!response.ok) {
    return { kind: "unreadable", message: "Your saved workflow state could not be read." };
  }

  let profile: ProfileSnapshot;

  try {
    profile = (await response.json()) as ProfileSnapshot;
  } catch {
    return { kind: "unreadable", message: "Your saved workflow state could not be read." };
  }

  return { kind: "profile", profile };
}

/**
 * Reads the caller's stored resume.
 *
 * Answers "is there a file, and what is it called" — the question the Resume
 * Upload node asks. `GET /api/resume` reports a missing file as `resume: null`
 * with a 200 rather than a 404, so absence is data here, not an error.
 */
async function readStoredResume(): Promise<StoredResume | null> {
  let response: Response;

  try {
    response = await userFetch("/api/resume", { cache: "no-store" });
  } catch {
    // The profile read carries the error message; a resume that cannot be read
    // just leaves the node as whatever the profile has to say about it.
    return null;
  }

  if (!response.ok) {
    return null;
  }

  try {
    const body = (await response.json()) as { resume?: StoredResume | null };

    if (body.resume === null || body.resume === undefined) {
      return null;
    }

    if (typeof body.resume.id !== "string" || typeof body.resume.originalFilename !== "string") {
      return null;
    }

    return body.resume;
  } catch {
    return null;
  }
}

export function Workflow({
  onRunDiscovery,
  onRestoreDiscovery,
  onDiscoveryInvalidated,
  onReadinessChange,
}: WorkflowProps) {
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>(emptySnapshot);
  const [resume, setResume] = useState<ResumeFacts>({ fileId: null, filename: null });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const discoveryConnected = onRunDiscovery !== undefined;

  /** Folds what the server says about the first three stages into the workflow. */
  const applyServerRead = useCallback(
    (read: ProfileRead, storedResume: StoredResume | null, filename: string | null) => {
      if (read.kind === "unreadable") {
        // Keep whatever the workflow already shows: a transient read failure
        // must not erase a run that is visibly in progress.
        setLoadError(read.message);
        return;
      }

      setLoadError(null);

      const profile = read.kind === "profile" ? read.profile : null;
      const profileFileId = profile?.resumeFileId;
      const hasProfileFile = typeof profileFileId === "string" && profileFileId.length > 0;

      setResume({
        fileId: hasProfileFile ? (profileFileId as string) : (storedResume?.id ?? null),
        filename: filename ?? storedResume?.originalFilename ?? null,
      });
      setSnapshot((previous) =>
        projectProfile(previous, { profile, resume: storedResume, filename })
      );

      const parsed =
        typeof profile?.resume?.name === "string" && profile.resume.name.trim().length > 0;
      const reviewed = typeof profile?.reviewedAt === "string" && profile.reviewedAt.length > 0;

      onReadinessChange?.({
        hasResume: hasProfileFile || storedResume !== null || filename !== null,
        hasProfile: profile !== null,
        parsed,
        reviewed,
      });
    },
    [onReadinessChange]
  );

  /**
   * Re-reads the server after a real request and applies the result.
   *
   * Both endpoints are read, because neither one answers every question: the
   * resume endpoint knows whether a file exists and what it is called, and the
   * profile endpoint knows whether that file has been parsed.
   */
  const syncFromServer = useCallback(
    async (filename: string | null) => {
      const [read, storedResume] = await Promise.all([readStoredProfile(), readStoredResume()]);
      applyServerRead(read, storedResume, filename);
    },
    [applyServerRead]
  );

  /**
   * The single way any runner reports a stage change, restore or run alike.
   *
   * Extracted so the restore path and the run path cannot drift into two
   * different ways of writing the same node state.
   */
  const makeReport = useCallback(
    (): DiscoveryReport => ({
      setStage: (stage, status, options) => {
        setSnapshot((previous) =>
          withStage(previous, stage, {
            status,
            ...(options?.detail === undefined ? {} : { detail: options.detail }),
            ...(options?.error === undefined ? {} : { error: options.error }),
          })
        );
      },
    }),
    []
  );

  /**
   * Applies a restored scan's stages once, on mount.
   *
   * The ref guard, not state, decides "once": React's strict mode invokes
   * effects twice, and a restore that ran twice would refetch a per-user
   * document for no reason. It lives for the life of the component, which is
   * exactly "one restore per page load" — and the thing being restored *is* the
   * previous page load.
   */
  const restoreAttempted = useRef(false);

  useEffect(() => {
    if (onRestoreDiscovery === undefined || restoreAttempted.current) {
      return;
    }

    restoreAttempted.current = true;
    void onRestoreDiscovery(makeReport());
  }, [makeReport, onRestoreDiscovery]);

  /**
   * Loads the stored state once, on mount.
   *
   * The effect body starts the requests and applies the result when they settle.
   * No state is written synchronously, so mounting does not cascade a render.
   */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    void Promise.all([readStoredProfile(), readStoredResume()]).then(([read, storedResume]) => {
      // A result that arrives after unmount has nowhere to go.
      if (mounted.current) {
        applyServerRead(read, storedResume, null);
      }
    });

    return () => {
      mounted.current = false;
    };
  }, [applyServerRead]);

  /** Runs the real parser against the stored resume file. */
  const parseResume = useCallback(
    async (resumeFileId: string) => {
      setSnapshot((previous) => withStage(previous, "parse-profile", { status: "processing" }));

      try {
        const response = await userFetch("/api/resume/parse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resumeFileId }),
        });
        const payload: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          setSnapshot((previous) =>
            withStage(previous, "parse-profile", {
              status: "failed",
              error: readErrorMessage(payload, "The resume could not be parsed."),
            })
          );
          return;
        }

        // Re-read the profile rather than trusting the parse body: the parse
        // response is the parser's own view, and the profile is what every
        // later stage reads.
        await syncFromServer(null);
      } catch {
        setSnapshot((previous) =>
          withStage(previous, "parse-profile", {
            status: "failed",
            error: "The resume could not be parsed.",
          })
        );
      }
    },
    [syncFromServer]
  );

  /**
   * A finished upload invalidates everything derived from the old resume.
   *
   * The new file is the only input that is true, so parse, review and the
   * discovery stages return to idle rather than showing a green tick for input
   * that no longer exists. Parsing then runs against the file that just landed.
   *
   * The discovery tail resetting is how this component tells the truth; the
   * `onDiscoveryInvalidated` call tells whoever rendered the previous scan's
   * results that those results are no longer this resume's, so a stale job list
   * cannot sit beneath a workflow that says nothing has run.
   */
  const handleUploadComplete = useCallback(
    async (filename: string, fileId: string) => {
      setUploadOpen(false);
      setResume({ fileId, filename });
      setSnapshot((previous) =>
        invalidateFrom(
          withStage(previous, "resume-upload", { status: "completed", detail: filename }),
          "parse-profile"
        )
      );
      onDiscoveryInvalidated?.();
      await parseResume(fileId);
    },
    [onDiscoveryInvalidated, parseResume]
  );

  const handleNodeActivate = useCallback(
    (stage: WorkflowStage) => {
      if (stage === "resume-upload") {
        // The entry point, whether or not a resume already exists: clicking a
        // completed node is how a resume gets replaced.
        setUploadOpen(true);
        return;
      }

      if (stage === "parse-profile" && resume.fileId !== null) {
        void parseResume(resume.fileId);
      }
    },
    [parseResume, resume.fileId]
  );

  const blockers = describeBlockers(snapshot, discoveryConnected);

  const handleStart = useCallback(async () => {
    if (onRunDiscovery === undefined) {
      return;
    }

    setRunning(true);

    try {
      await onRunDiscovery(makeReport());
    } finally {
      setRunning(false);
    }
  }, [makeReport, onRunDiscovery]);

  const errorMessage = loadError ?? readFirstFailure(snapshot);
  const runningMessage = describeRunning(snapshot);

  // A completed match stage means this browser has already seen a full scan
  // (run now, or restored from the last one), so the control that used to start
  // the search now repeats it. Same action, honest label.
  const hasRunScan = snapshot["job-matches"].status === "completed";

  return (
    <div className="flex flex-col gap-4">
      <WorkflowGraph snapshot={snapshot} onNodeActivate={handleNodeActivate} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={blockers.length > 0 || running}
          aria-disabled={blockers.length > 0 || running}
          className={[
            "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors",
            blockers.length === 0 && !running
              ? "border-emerald-500/40 bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
              : "cursor-not-allowed border-[var(--border)] bg-[var(--surface-raised)] text-zinc-400",
          ].join(" ")}
        >
          <PlayIcon className="size-4" />
          {running ? "Running…" : hasRunScan ? "Run Again" : "Start Workflow"}
        </button>

        {runningMessage !== null ? (
          <p className="flex items-center gap-2 text-sm text-amber-300" role="status">
            <span
              aria-hidden="true"
              className="size-3 animate-spin rounded-full border-2 border-amber-400/40 border-t-amber-300 motion-reduce:animate-none"
            />
            {runningMessage}
          </p>
        ) : blockers.length > 0 ? (
          <p className="text-[13px] text-zinc-400" role="status">
            {blockers.join(" ")}
          </p>
        ) : null}
      </div>

      {errorMessage !== null ? (
        <p
          role="alert"
          className="rounded-xl border border-red-500/40 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300"
        >
          {errorMessage}
        </p>
      ) : null}

      <UploadModal
        key={uploadOpen ? "open" : "closed"}
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onComplete={(filename, fileId) => void handleUploadComplete(filename, fileId)}
      />
    </div>
  );
}

/**
 * Projects the server's facts onto the workflow.
 *
 * Exported so the mapping from what the server actually says to node states can
 * be reasoned about (and tested) independently of React.
 *
 * Three facts, three meanings:
 *
 * - A stored file — from `GET /api/resume`, or `resumeFileId` when the profile
 *   has one — means an upload happened. Reading only the profile here would
 *   under-report: a file that has never been parsed has no `resumeFileId` yet,
 *   and the node would claim no resume exists while one is sitting on the
 *   server.
 * - Parsed content means parsing happened. Content without a name is empty
 *   content, so it does not count.
 * - `reviewedAt` means a person saved the profile through Profile Review. It is
 *   the review stage's server-side marker, and it is cleared by the repository
 *   whenever a fresh parse replaces the text it referred to — so a replacement
 *   resume drops review back to idle on its own, without this function having to
 *   guess that the old review no longer applies.
 *
 * The three discovery stages are never touched: this function has no idea what
 * happened to them, because the job-search backend reports those itself.
 */
export function projectProfile(
  previous: WorkflowSnapshot,
  facts: ServerFacts,
): WorkflowSnapshot {
  const { profile, resume, filename } = facts;

  const profileFileId = typeof profile?.resumeFileId === "string" ? profile.resumeFileId : "";
  const storedId = resume === null ? "" : resume.id;
  const fileId = profileFileId.length > 0 ? profileFileId : storedId;

  if (fileId.length === 0) {
    return emptySnapshot();
  }

  const hasParsedContent =
    typeof profile?.resume?.name === "string" && profile.resume.name.trim().length > 0;

  const resumed = withStage(previous, "resume-upload", {
    status: "completed",
    detail: filename ?? resume?.originalFilename ?? shortenId(fileId),
  });

  if (!hasParsedContent) {
    // A resume with no parsed content is a resume awaiting its parse. Parse is
    // in flight (the user just uploaded) rather than failed, so the failure path
    // stays meaningful for actual failures.
    return withStage(resumed, "parse-profile", {
      status: previous["parse-profile"].status === "processing" ? "processing" : "idle",
    });
  }

  const parsed = withStage(resumed, "parse-profile", { status: "completed" });

  const reviewed =
    typeof profile?.reviewedAt === "string" && profile.reviewedAt.length > 0;

  return withStage(parsed, "review-profile", {
    // Idle rather than failed when nobody has reviewed yet: there is something
    // to look at, which is exactly what the caption says.
    status: reviewed ? "completed" : "idle",
    ...(reviewed ? {} : { detail: "Open to review" }),
  });
}

/** Reads the API's error envelope, falling back to a plain sentence. */
function readErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) {
    return fallback;
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return fallback;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

/** The first real failure in the pipeline, so the user is told once, clearly. */
function readFirstFailure(snapshot: WorkflowSnapshot): string | null {
  for (const stage of ["resume-upload", "parse-profile", "review-profile"] as const) {
    const error = snapshot[stage].error;
    if (error !== undefined) {
      return error;
    }
  }

  return null;
}

/**
 * A contextual line for whatever stage is genuinely running.
 *
 * Derived from the same snapshot the nodes read, so it can never announce work
 * the pipeline did not start. The search and the processing happen inside one
 * request, so the search wording wins while it is open; the processing wording
 * is reachable on its own only if that ever splits.
 */
function describeRunning(snapshot: WorkflowSnapshot): string | null {
  if (snapshot["parse-profile"].status === "processing") {
    return "Parsing your resume…";
  }

  if (snapshot.serpapi.status === "processing") {
    return "Searching live jobs…";
  }

  if (snapshot.process.status === "processing") {
    return "Filtering and ranking matches…";
  }

  if (snapshot["resume-upload"].status === "processing") {
    return "Uploading your resume…";
  }

  return null;
}

/** Abbreviates a stored file id for display. The profile API returns no filename. */
function shortenId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}