/**
 * State model for the six-node Job Radar workflow.
 *
 * This module is deliberately plain data: no React, no fetch, no timers. It
 * answers three questions and nothing else:
 *
 *   1. which nodes exist, in which order (there are exactly six);
 *   2. which wires exist between them (there are exactly five);
 *   3. what a node and a wire should look like given the current snapshot.
 *
 * The component layer turns a snapshot into markup. This layer is what the
 * tests exercise directly, so the workflow's structure and state transitions can
 * be verified without a browser.
 *
 * Nothing in here invents progress. A stage is `completed` because a real
 * request succeeded and the caller said so; there is no code path that advances
 * a stage on its own.
 */

/** Execution state of a single workflow node. */
export type WorkflowNodeStatus = "idle" | "processing" | "completed" | "failed";

/**
 * The visible pipeline, in execution order.
 *
 * This is the *only* list of stages the user sees. Internal operations —
 * normalization, deduplication, freshness and salary filtering, relevance
 * scoring, storage — are folded into `process` on purpose: they are steps
 * inside a stage, not stages.
 */
export const WORKFLOW_STAGES = [
  "resume-upload",
  "parse-profile",
  "review-profile",
  "serpapi",
  "process",
  "job-matches",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/**
 * The three stages the job-search backend owns.
 *
 * The workflow UI can represent their state but never implements it. Whoever
 * builds the search pipeline reports transitions through these.
 */
export type DiscoveryStage = Extract<WorkflowStage, "serpapi" | "process" | "job-matches">;

/** State of one stage, as reported by whoever actually performed the work. */
export type StageState = {
  status: WorkflowNodeStatus;
  /** Short line shown under the node's label, e.g. a filename. */
  detail?: string;
  /** Real failure message from the request that failed. */
  error?: string;
};

/**
 * The complete workflow state.
 *
 * A record keyed by stage rather than a per-node array, so a stage can never be
 * rendered without a state and a missing key is a type error rather than an
 * `undefined` at runtime.
 */
export type WorkflowSnapshot = Record<WorkflowStage, StageState>;

/** A snapshot in which nothing has run yet. */
export function emptySnapshot(): WorkflowSnapshot {
  return {
    "resume-upload": { status: "idle" },
    "parse-profile": { status: "idle" },
    "review-profile": { status: "idle" },
    serpapi: { status: "idle" },
    process: { status: "idle" },
    "job-matches": { status: "idle" },
  };
}

/**
 * Static definition of the six visible nodes.
 *
 * `requires` lists the stages that must have completed before a node becomes
 * actionable. It is what makes "Parse Profile becomes available" a fact rather
 * than a guess, and it is what stops a downstream stage from looking ready when
 * its input does not exist.
 *
 * There are deliberately no step numbers. The order of the nodes communicates
 * the sequence.
 */
export const WORKFLOW_NODE_DEFINITIONS: readonly {
  stage: WorkflowStage;
  label: string;
  secondaryLabel?: string;
  requires: readonly WorkflowStage[];
}[] = [
  { stage: "resume-upload", label: "Resume Upload", requires: [] },
  { stage: "parse-profile", label: "Parse Profile", requires: ["resume-upload"] },
  { stage: "review-profile", label: "Review Profile", requires: ["parse-profile"] },
  { stage: "serpapi", label: "SerpApi", secondaryLabel: "GOOGLE JOBS", requires: ["review-profile"] },
  { stage: "process", label: "Process", requires: ["serpapi"] },
  { stage: "job-matches", label: "Job Matches", requires: ["process"] },
];

/** Everything the node renderer needs, derived from a snapshot. */
export type WorkflowNodeView = {
  stage: WorkflowStage;
  label: string;
  secondaryLabel?: string;
  status: WorkflowNodeStatus;
  /** False while an upstream stage is incomplete; the node is shown, not hidden. */
  available: boolean;
  /** Line under the label: real detail when there is any, otherwise a hint. */
  caption: string;
  /** Real failure text, when the stage failed. */
  error?: string;
};

/** Wire state between two adjacent nodes. */
export type WorkflowWireState = "idle" | "flowing" | "settled" | "failed";

export type WorkflowWireView = {
  from: WorkflowStage;
  to: WorkflowStage;
  state: WorkflowWireState;
};

/**
 * Fallback caption when an available node has no real detail to show.
 *
 * Only reachable once the node's requirements are met, so these read as
 * readiness, not as waiting: `parse-profile` is available exactly when a resume
 * exists, so telling the user it is "awaiting resume" would contradict the node
 * directly above it. The unavailable case is handled separately by
 * {@link WAITING_CAPTION}, and a running or finished stage by
 * {@link PROCESSING_CAPTIONS} and {@link COMPLETED_CAPTIONS} so a node can never
 * announce "ready to parse" while it is already parsing or done.
 */
const IDLE_CAPTIONS: Record<WorkflowStage, string> = {
  "resume-upload": "PDF / DOCX",
  "parse-profile": "Ready to parse",
  "review-profile": "Ready to review",
  serpapi: "Ready to search",
  process: "Ready to process",
  "job-matches": "Ready to show matches",
};

/**
 * What a stage says while it is running and has no detail yet.
 *
 * It names the action rather than the fact that something is happening — the
 * status word already says that, and the stage name is on the row above.
 */
const PROCESSING_CAPTIONS: Record<WorkflowStage, string> = {
  "resume-upload": "Uploading…",
  "parse-profile": "Parsing…",
  "review-profile": "Reviewing…",
  serpapi: "Searching…",
  process: "Processing…",
  "job-matches": "Finding matches…",
};

/** What a finished stage says when it has no detail of its own to show. */
const COMPLETED_CAPTIONS: Record<WorkflowStage, string> = {
  "resume-upload": "Uploaded",
  "parse-profile": "Parsed",
  "review-profile": "Reviewed",
  serpapi: "Searched",
  process: "Processed",
  "job-matches": "Matches ready",
};

const WAITING_CAPTION = "Waiting";

/**
 * Builds the six node views from a snapshot.
 *
 * Always returns six entries in pipeline order, so the rendered graph has a
 * fixed shape and a missing stage can never silently disappear from the UI.
 */
export function deriveWorkflowNodes(snapshot: WorkflowSnapshot): WorkflowNodeView[] {
  return WORKFLOW_NODE_DEFINITIONS.map((definition) => {
    const state = snapshot[definition.stage];
    const available = definition.requires.every(
      (requirement) => snapshot[requirement].status === "completed"
    );

    return {
      stage: definition.stage,
      label: definition.label,
      ...(definition.secondaryLabel === undefined
        ? {}
        : { secondaryLabel: definition.secondaryLabel }),
      status: state.status,
      available,
      caption: buildCaption(definition.stage, state, available),
      ...(state.error === undefined ? {} : { error: state.error }),
    };
  });
}

/**
 * Chooses the line under a node's label.
 *
 * Precedence is deliberate: a real detail wins, then a real failure, then the
 * node's own status. Availability only decides the wording between "waiting" and
 * "ready" for a node that is idle — it must never downgrade a stage that is
 * running or finished, because a stage can legitimately complete while an
 * upstream stage it does not depend on for its own work is still open. Nothing
 * here is generated from a timer.
 */
function buildCaption(
  stage: WorkflowStage,
  state: StageState,
  available: boolean
): string {
  if (state.error !== undefined) {
    return state.error;
  }

  if (state.detail !== undefined && state.detail.length > 0) {
    return state.detail;
  }

  if (state.status === "processing") {
    return PROCESSING_CAPTIONS[stage];
  }

  if (state.status === "completed") {
    return COMPLETED_CAPTIONS[stage];
  }

  if (!available) {
    return WAITING_CAPTION;
  }

  return IDLE_CAPTIONS[stage];
}

/**
 * Builds the five wires.
 *
 * A wire is derived from the two nodes it joins, so a node that fails also
 * shows its incoming wire as failed, and no wire can claim progress on its own.
 */
export function deriveWorkflowWires(nodes: readonly WorkflowNodeView[]): WorkflowWireView[] {
  const wires: WorkflowWireView[] = [];

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];

    wires.push({
      from: from.stage,
      to: to.stage,
      state: deriveWireState(from.status, to.status),
    });
  }

  return wires;
}

/**
 * The single rule for a wire's appearance.
 *
 * A failed end poisons the wire. A processing target means data is moving into
 * it right now, which is the only time the travelling signal is shown. A
 * completed source means the stage behind the wire is done. Otherwise the wire
 * is plain and static.
 */
export function deriveWireState(
  from: WorkflowNodeStatus,
  to: WorkflowNodeStatus
): WorkflowWireState {
  if (from === "failed" || to === "failed") {
    return "failed";
  }

  if (to === "processing") {
    return "flowing";
  }

  if (from === "completed") {
    return "settled";
  }

  return "idle";
}

/**
 * Resets a stage and everything after it.
 *
 * Called when an upstream input changes — a new resume, a re-saved profile — so
 * the pipeline never shows a green stage that was produced by input which no
 * longer exists. Upstream stages keep their state; only the tail is cleared.
 */
export function invalidateFrom(snapshot: WorkflowSnapshot, stage: WorkflowStage): WorkflowSnapshot {
  const cut = WORKFLOW_STAGES.indexOf(stage);
  const next = { ...snapshot };

  for (const candidate of WORKFLOW_STAGES.slice(cut)) {
    next[candidate] = { status: "idle" };
  }

  return next;
}

/** Replaces the state of a single stage, leaving every other stage untouched. */
export function withStage(
  snapshot: WorkflowSnapshot,
  stage: WorkflowStage,
  state: StageState
): WorkflowSnapshot {
  return { ...snapshot, [stage]: state };
}

/** The first stage that has not completed, or `null` when the pipeline is done. */
export function nextIncompleteStage(snapshot: WorkflowSnapshot): WorkflowStage | null {
  return WORKFLOW_STAGES.find((stage) => snapshot[stage].status !== "completed") ?? null;
}

/** Whether a stage is in flight, which is when its wire may animate. */
export function isBusy(snapshot: WorkflowSnapshot): boolean {
  return WORKFLOW_STAGES.some((stage) => snapshot[stage].status === "processing");
}

/**
 * What still stands between the user and a real workflow run, as sentences.
 *
 * Read straight off the snapshot, so the hint can never claim a prerequisite is
 * met while the pipeline says otherwise. An empty result means the run can
 * genuinely start.
 *
 * `discoveryConnected` says whether anything has been wired to actually perform
 * the search. While it is false, Start Workflow stays disabled rather than
 * pretending a run began; the caller passes true only once a real search
 * implementation is attached.
 */
export function describeBlockers(
  snapshot: WorkflowSnapshot,
  discoveryConnected: boolean
): string[] {
  const blockers: string[] = [];

  const resume = snapshot["resume-upload"];
  if (resume.status === "failed") {
    blockers.push("The resume upload failed — try again.");
  } else if (resume.status !== "completed") {
    blockers.push("Upload a resume to start.");
  }

  const parse = snapshot["parse-profile"];
  if (parse.status === "failed") {
    blockers.push("Parsing failed — retry Parse Profile.");
  } else if (parse.status !== "completed") {
    blockers.push("Your resume has not been parsed yet.");
  }

  const review = snapshot["review-profile"];
  if (review.status === "failed") {
    blockers.push("Profile review failed — reopen it.");
  } else if (review.status !== "completed") {
    blockers.push("Review your profile to start.");
  }

  if (!discoveryConnected) {
    blockers.push("Job search is not connected yet.");
  }

  return blockers;
}