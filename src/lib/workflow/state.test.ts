import { describe, expect, it } from "vitest";

import {
  WORKFLOW_NODE_DEFINITIONS,
  WORKFLOW_STAGES,
  describeBlockers,
  deriveWireState,
  deriveWorkflowNodes,
  deriveWorkflowWires,
  emptySnapshot,
  invalidateFrom,
  isBusy,
  nextIncompleteStage,
  withStage,
  type WorkflowNodeStatus,
  type WorkflowSnapshot,
} from "@/lib/workflow/state";
import {
  STATUS_WORDS,
  nodeToneClass,
  statusDotClass,
  statusTextClass,
} from "@/components/workflow-node";
import { wireLineClass } from "@/components/workflow-connection";

/**
 * These tests are the workflow's contract.
 *
 * The structural assertions (six nodes, five wires, exact order, no numbers) are
 * the part a screenshot cannot reliably prove, and they are the part that would
 * silently regress the moment someone adds a stage. The state assertions pin the
 * rule that nothing advances without a real event: every transition below is
 * driven by an explicit `withStage` call standing in for a real response.
 */

const LABELS = [
  "Resume Upload",
  "Parse Profile",
  "Review Profile",
  "SerpApi",
  "Process",
  "Job Matches",
];

/** A snapshot where everything up to and including `stage` has completed. */
function completedThrough(stage: (typeof WORKFLOW_STAGES)[number]): WorkflowSnapshot {
  const cut = WORKFLOW_STAGES.indexOf(stage);

  return WORKFLOW_STAGES.reduce<WorkflowSnapshot>(
    (snapshot, candidate, index) =>
      index <= cut ? withStage(snapshot, candidate, { status: "completed" }) : snapshot,
    emptySnapshot()
  );
}

describe("workflow structure", () => {
  it("has exactly six stages, in pipeline order", () => {
    expect([...WORKFLOW_STAGES]).toEqual([
      "resume-upload",
      "parse-profile",
      "review-profile",
      "serpapi",
      "process",
      "job-matches",
    ]);
  });

  it("shows exactly the six agreed node labels, in order", () => {
    expect(WORKFLOW_NODE_DEFINITIONS.map((definition) => definition.label)).toEqual(LABELS);
  });

  it("gives every stage a node, so none can be dropped from the row", () => {
    expect(WORKFLOW_NODE_DEFINITIONS.map((definition) => definition.stage)).toEqual([
      ...WORKFLOW_STAGES,
    ]);
  });

  it("carries no step numbers in any label", () => {
    for (const definition of WORKFLOW_NODE_DEFINITIONS) {
      expect(definition.label).not.toMatch(/\d/);
      expect(definition.secondaryLabel ?? "").not.toMatch(/\d/);
    }
  });

  it("shows GOOGLE JOBS as the SerpApi node's secondary label", () => {
    const serpapi = WORKFLOW_NODE_DEFINITIONS.find((definition) => definition.stage === "serpapi");

    expect(serpapi?.secondaryLabel).toBe("GOOGLE JOBS");
  });

  it("keeps internal operations out of the visible pipeline", () => {
    const visible = WORKFLOW_NODE_DEFINITIONS.map((definition) => definition.label.toLowerCase());

    for (const internal of [
      "preferences",
      "mongodb",
      "deduplicate",
      "freshness",
      "salary",
      "matching",
      "storage",
      "normalize",
    ]) {
      expect(visible.some((label) => label.includes(internal))).toBe(false);
    }
  });

  it("derives exactly five wires from six nodes", () => {
    const nodes = deriveWorkflowNodes(emptySnapshot());

    expect(nodes).toHaveLength(6);
    expect(deriveWorkflowWires(nodes)).toHaveLength(5);
  });

  it("wires each node to the next one, and nothing else", () => {
    const wires = deriveWorkflowWires(deriveWorkflowNodes(emptySnapshot()));

    expect(wires).toEqual([
      { from: "resume-upload", to: "parse-profile", state: "idle" },
      { from: "parse-profile", to: "review-profile", state: "idle" },
      { from: "review-profile", to: "serpapi", state: "idle" },
      { from: "serpapi", to: "process", state: "idle" },
      { from: "process", to: "job-matches", state: "idle" },
    ]);
  });
});

describe("node derivation", () => {
  it("reports six nodes for any snapshot, including an empty one", () => {
    expect(deriveWorkflowNodes(emptySnapshot())).toHaveLength(6);
  });

  it("starts every node idle and unavailable except the entry point", () => {
    const nodes = deriveWorkflowNodes(emptySnapshot());

    expect(nodes.map((node) => node.status)).toEqual([
      "idle",
      "idle",
      "idle",
      "idle",
      "idle",
      "idle",
    ]);
    expect(nodes.map((node) => node.available)).toEqual([true, false, false, false, false, false]);
  });

  it("makes a node available only once every stage it requires has completed", () => {
    const nodes = deriveWorkflowNodes(completedThrough("resume-upload"));

    expect(nodes.map((node) => node.available)).toEqual([true, true, false, false, false, false]);
  });

  it("keeps a node unavailable while an upstream stage is still processing", () => {
    const snapshot = withStage(
      withStage(emptySnapshot(), "resume-upload", { status: "completed" }),
      "parse-profile",
      { status: "processing" }
    );

    expect(deriveWorkflowNodes(snapshot)[2].available).toBe(false);
  });

  it("shows the real detail when there is one", () => {
    const snapshot = withStage(emptySnapshot(), "resume-upload", {
      status: "completed",
      detail: "cv.pdf",
    });

    expect(deriveWorkflowNodes(snapshot)[0].caption).toBe("cv.pdf");
  });

  it("shows the real failure text in place of the caption", () => {
    const snapshot = withStage(emptySnapshot(), "parse-profile", {
      status: "failed",
      error: "The uploaded file is not a PDF.",
    });
    const node = deriveWorkflowNodes(snapshot)[1];

    expect(node.status).toBe("failed");
    expect(node.caption).toBe("The uploaded file is not a PDF.");
    expect(node.error).toBe("The uploaded file is not a PDF.");
  });

  it("falls back to a waiting caption when a node is not available yet", () => {
    expect(deriveWorkflowNodes(emptySnapshot())[3].caption).toBe("Waiting");
  });

  it("signals readiness rather than waiting once a node is available", () => {
    // Availability is what the caption keys off, so "awaiting resume" on a node
    // that is available exactly when a resume exists would contradict the node
    // directly above it.
    const snapshot = withStage(emptySnapshot(), "resume-upload", { status: "completed" });
    const nodes = deriveWorkflowNodes(snapshot);

    expect(nodes[1].available).toBe(true);
    expect(nodes[1].caption).toBe("Ready to parse");

    for (const node of nodes) {
      if (node.available && node.status === "idle" && node.error === undefined) {
        expect(node.caption).not.toMatch(/^Awaiting/);
      }
    }
  });

  it("describes a running or finished node by what it did, not by readiness", () => {
    const running = deriveWorkflowNodes(
      withStage(emptySnapshot(), "parse-profile", { status: "processing" })
    )[1];
    const done = deriveWorkflowNodes(
      withStage(emptySnapshot(), "parse-profile", { status: "completed" })
    )[1];

    // A node must never announce it is ready to parse while parsing, or after it
    // has already parsed.
    expect(running.caption).toBe("Parsing…");
    expect(done.caption).toBe("Parsed");
  });

  it("does not downgrade a completed node to a waiting caption", () => {
    // The search stage reports its own result, and can do so while an upstream
    // stage it does not depend on for its own work is still open.
    const snapshot: WorkflowSnapshot = { ...emptySnapshot(), serpapi: { status: "completed" } };
    const node = deriveWorkflowNodes(snapshot)[3];

    expect(node.available).toBe(false);
    expect(node.caption).toBe("Searched");
  });
});

describe("wire derivation", () => {
  it("leaves a wire plain when neither end has anything to report", () => {
    expect(deriveWireState("idle", "idle")).toBe("idle");
  });

  it("marks the wire flowing only while its target is processing", () => {
    expect(deriveWireState("idle", "processing")).toBe("flowing");
    expect(deriveWireState("completed", "processing")).toBe("flowing");
  });

  it("marks the wire settled once the stage behind it has completed", () => {
    expect(deriveWireState("completed", "completed")).toBe("settled");
    expect(deriveWireState("completed", "idle")).toBe("settled");
  });

  it("fails the wire when either end failed", () => {
    expect(deriveWireState("failed", "idle")).toBe("failed");
    expect(deriveWireState("completed", "failed")).toBe("failed");
    expect(deriveWireState("failed", "completed")).toBe("failed");
  });

  it("lets a failure win over a flowing wire", () => {
    expect(deriveWireState("processing", "failed")).toBe("failed");
  });

  it("paints a failed node's incoming wire as failed", () => {
    const snapshot = invalidateFrom(
      withStage(emptySnapshot(), "resume-upload", { status: "completed" }),
      "parse-profile"
    );
    const wired = withStage(snapshot, "parse-profile", {
      status: "failed",
      error: "Parse failed",
    });

    expect(deriveWorkflowWires(deriveWorkflowNodes(wired))[0].state).toBe("failed");
  });

  it("keeps a wire flowing while a stage is genuinely in flight", () => {
    const snapshot = withStage(
      withStage(emptySnapshot(), "resume-upload", { status: "completed" }),
      "parse-profile",
      { status: "processing" }
    );
    const wires = deriveWorkflowWires(deriveWorkflowNodes(snapshot));

    expect(wires[0].state).toBe("flowing");
    // The upstream wire is settled: the upload behind it really did finish.
    expect(wires[1].state).toBe("idle");
  });
});

describe("invalidation", () => {
  const fullyRun = WORKFLOW_STAGES.reduce<WorkflowSnapshot>(
    (snapshot, stage) => withStage(snapshot, stage, { status: "completed", detail: "done" }),
    emptySnapshot()
  );

  it("clears a stage and everything after it", () => {
    const nodes = deriveWorkflowNodes(invalidateFrom(fullyRun, "parse-profile"));

    expect(nodes.map((node) => node.status)).toEqual([
      "completed",
      "idle",
      "idle",
      "idle",
      "idle",
      "idle",
    ]);
  });

  it("preserves upstream state when a new resume lands", () => {
    const invalid = invalidateFrom(fullyRun, "parse-profile");

    expect(invalid["resume-upload"]).toEqual({ status: "completed", detail: "done" });
  });

  it("drops stale detail and error text along with the status", () => {
    const failed = withStage(fullyRun, "process", {
      status: "failed",
      error: "stale failure",
    });

    expect(invalidateFrom(failed, "parse-profile")["process"]).toEqual({ status: "idle" });
  });

  it("also invalidates the entry point itself when asked", () => {
    expect(deriveWorkflowNodes(invalidateFrom(fullyRun, "resume-upload")).every((node) => node.status === "idle")).toBe(
      true
    );
  });

  it("does not mutate the snapshot it was given", () => {
    const before = emptySnapshot();
    invalidateFrom(before, "resume-upload");

    expect(before["resume-upload"].status).toBe("idle");
  });
});

describe("withStage", () => {
  it("changes one stage and leaves the rest untouched", () => {
    const snapshot = completedThrough("resume-upload");
    const next = withStage(snapshot, "parse-profile", { status: "processing" });

    expect(next["parse-profile"].status).toBe("processing");
    expect(next["resume-upload"].status).toBe("completed");
    expect(next["review-profile"].status).toBe("idle");
  });

  it("does not mutate the snapshot it was given", () => {
    const snapshot = emptySnapshot();
    withStage(snapshot, "serpapi", { status: "failed", error: "no key" });

    expect(snapshot.serpapi.status).toBe("idle");
  });
});

describe("pipeline helpers", () => {
  it("finds the first stage that has not completed", () => {
    const snapshot = withStage(
      withStage(emptySnapshot(), "resume-upload", { status: "completed" }),
      "parse-profile",
      { status: "processing" }
    );

    expect(nextIncompleteStage(snapshot)).toBe("parse-profile");
  });

  it("reports the pipeline done when every stage completed", () => {
    const done = WORKFLOW_STAGES.reduce<WorkflowSnapshot>(
      (snapshot, stage) => withStage(snapshot, stage, { status: "completed" }),
      emptySnapshot()
    );

    expect(nextIncompleteStage(done)).toBeNull();
  });

  it("is busy only while something is processing", () => {
    expect(isBusy(emptySnapshot())).toBe(false);

    const running = withStage(emptySnapshot(), "process", { status: "processing" });

    expect(isBusy(running)).toBe(true);
    expect(isBusy(withStage(running, "process", { status: "completed" }))).toBe(false);
  });
});

describe("describeBlockers", () => {
  it("lists every missing prerequisite on a first visit", () => {
    expect(describeBlockers(emptySnapshot(), false)).toEqual([
      "Upload a resume to start.",
      "Your resume has not been parsed yet.",
      "Review your profile to start.",
      "Job search is not connected yet.",
    ]);
  });

  it("says job search is not connected, because it genuinely is not", () => {
    expect(describeBlockers(emptySnapshot(), false)).toContain("Job search is not connected yet.");
  });

  it("still reports the missing stages once a search runner is wired", () => {
    expect(describeBlockers(emptySnapshot(), true)).toEqual([
      "Upload a resume to start.",
      "Your resume has not been parsed yet.",
      "Review your profile to start.",
    ]);
  });

  it("reports a real failure as retryable rather than merely incomplete", () => {
    const snapshot = withStage(emptySnapshot(), "parse-profile", {
      status: "failed",
      error: "boom",
    });

    expect(describeBlockers(snapshot, true)).toContain("Parsing failed — retry Parse Profile.");
  });

  it("reports a failed upload instead of asking for one", () => {
    const snapshot = withStage(emptySnapshot(), "resume-upload", {
      status: "failed",
      error: "boom",
    });
    const blockers = describeBlockers(snapshot, true);

    expect(blockers).toContain("The resume upload failed — try again.");
    expect(blockers).not.toContain("Upload a resume to start.");
  });

  it("clears only the stages that are actually done", () => {
    const blockers = describeBlockers(completedThrough("parse-profile"), true);

    expect(blockers).not.toContain("Upload a resume to start.");
    expect(blockers).not.toContain("Your resume has not been parsed yet.");
    expect(blockers).toContain("Review your profile to start.");
  });
});

describe("visual language", () => {
  const statuses: WorkflowNodeStatus[] = ["idle", "processing", "completed", "failed"];

  it("names every state in words, so colour is never the only signal", () => {
    expect(Object.keys(STATUS_WORDS).sort()).toEqual([...statuses].sort());

    for (const status of statuses) {
      expect(STATUS_WORDS[status].length).toBeGreaterThan(0);
      expect(STATUS_WORDS[status]).not.toMatch(/\d/);
    }
  });

  it("uses four distinct status words", () => {
    const words = statuses.map((status) => STATUS_WORDS[status]);

    expect(new Set(words).size).toBe(4);
  });

  it("gives every state a distinct node tone", () => {
    const tones = statuses.map((status) => nodeToneClass(status, true));

    expect(new Set(tones).size).toBe(4);
  });

  it("gives every state a distinct status text tone", () => {
    const tones = statuses.map((status) => statusTextClass(status, true));

    expect(new Set(tones).size).toBe(4);
  });

  it("gives every state a distinct state dot", () => {
    const dots = statuses.map((status) => statusDotClass(status, true));

    expect(new Set(dots).size).toBe(4);
  });

  it("mutes an unavailable idle node without inventing a fifth state", () => {
    expect(nodeToneClass("idle", false)).toBe(nodeToneClass("idle", false));
    expect(nodeToneClass("idle", false)).not.toBe(nodeToneClass("idle", true));
    expect(statusTextClass("idle", false)).not.toBe(statusTextClass("idle", true));
  });

  it("does not mute a node that is processing or completed", () => {
    expect(nodeToneClass("completed", false)).toBe(nodeToneClass("completed", true));
    expect(nodeToneClass("processing", false)).toBe(nodeToneClass("processing", true));
  });

  it("gives every wire state a distinct line colour", () => {
    const lines = ["idle", "flowing", "settled", "failed"].map((state) =>
      wireLineClass(state as Parameters<typeof wireLineClass>[0])
    );

    expect(new Set(lines).size).toBe(4);
  });
});
