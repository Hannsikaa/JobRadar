import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkflowGraph } from "@/components/workflow-graph";
import { WorkflowContent } from "@/components/workflow-content";
import {
  WORKFLOW_STAGES,
  emptySnapshot,
  withStage,
  type WorkflowSnapshot,
} from "@/lib/workflow/state";

/**
 * Render-level tests for the workflow's shape.
 *
 * These render to static markup rather than to a DOM: the project's test
 * environment is Node, with no jsdom and no testing-library installed, and adding
 * a DOM stack for six divs would be a larger change than the thing being tested.
 * Static markup is enough to assert structure — order, counts, hrefs, labels and
 * the state classes that carry each node's status.
 */

function render(snapshot: WorkflowSnapshot = emptySnapshot()): string {
  return renderToStaticMarkup(
    createElement(WorkflowGraph, { snapshot, onNodeActivate: () => undefined })
  );
}

/** The `data-stage` values, in document order — i.e. the order they are shown. */
function stageOrder(markup: string): string[] {
  return [...markup.matchAll(/data-stage="([^"]+)"/g)].map((match) => match[1]);
}

function countOf(markup: string, token: string): number {
  return markup.split(token).length - 1;
}

describe("WorkflowGraph structure", () => {
  it("renders exactly six nodes, in pipeline order", () => {
    const markup = render();

    expect(countOf(markup, 'data-testid="workflow-node"')).toBe(6);
    expect(stageOrder(markup)).toEqual([...WORKFLOW_STAGES]);
  });

  it("renders exactly five wires", () => {
    expect(countOf(render(), 'data-testid="workflow-wire"')).toBe(5);
  });

  it("renders one wire in each gap, so no single line spans the row", () => {
    const markup = render();

    // Each wire is rendered inside the list item of the node it feeds, after
    // exactly one node's markup and before the next one.
    expect(markup.split('data-testid="workflow-wire"')).toHaveLength(6);
  });

  it("places a wire between every pair of adjacent nodes", () => {
    const markup = render();
    const sequence = [...markup.matchAll(/data-testid="(workflow-(?:node|wire))"/g)].map(
      (match) => match[1]
    );

    expect(sequence).toEqual([
      "workflow-node",
      "workflow-wire",
      "workflow-node",
      "workflow-wire",
      "workflow-node",
      "workflow-wire",
      "workflow-node",
      "workflow-wire",
      "workflow-node",
      "workflow-wire",
      "workflow-node",
    ]);
  });

  it("puts each wire's state in the markup, not just in a class", () => {
    const upstreamDone = (next: WorkflowSnapshot) =>
      withStage(next, "resume-upload", { status: "completed" });

    const snapshots = [
      emptySnapshot(),
      upstreamDone(withStage(emptySnapshot(), "parse-profile", { status: "processing" })),
      upstreamDone(withStage(emptySnapshot(), "parse-profile", { status: "completed" })),
      upstreamDone(
        withStage(emptySnapshot(), "parse-profile", { status: "failed", error: "nope" })
      ),
    ];

    for (const snapshot of snapshots) {
      const wires = [...render(snapshot).matchAll(/data-wire-state="([^"]+)"/g)].map(
        (match) => match[1]
      );

      expect(wires).toHaveLength(5);
      expect(wires.every((state) => state.length > 0)).toBe(true);
    }

    // And all four wire states are actually reachable from a real snapshot.
    const allStates = snapshots.flatMap((snapshot) =>
      [...render(snapshot).matchAll(/data-wire-state="([^"]+)"/g)].map((match) => match[1])
    );

    for (const state of ["idle", "flowing", "settled", "failed"]) {
      expect(allStates).toContain(state);
    }
  });

  it("stacks the pipeline on small screens and runs it in one row on large ones", () => {
    const markup = render();

    // A phone reads the six stages top-to-bottom; only at the desktop
    // breakpoint does the pipeline return to a single row.
    expect(markup).toContain("flex-col");
    expect(markup).toContain("lg:flex-row");
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("<ol");
  });

  it("labels the row as a group for assistive tech", () => {
    expect(render()).toContain('aria-label="Job Radar workflow"');
  });
});

describe("WorkflowGraph content", () => {
  it("shows the six agreed labels and nothing numeric", () => {
    const markup = render();

    for (const label of [
      "Resume Upload",
      "Parse Profile",
      "Review Profile",
      "SerpApi",
      "Process",
      "Job Matches",
    ]) {
      expect(markup).toContain(label);
    }
  });

  it("shows GOOGLE JOBS as the SerpApi node's secondary label", () => {
    const markup = render();
    const serpapi = markup.slice(markup.indexOf('data-stage="serpapi"'));

    expect(serpapi).toContain("GOOGLE JOBS");
  });

  it("does not invent a filename for an unloaded resume", () => {
    // The first-run caption is the accepted format, not a made-up document.
    expect(render()).toContain("PDF / DOCX");
  });

  it("links Review Profile to the real profile editor", () => {
    expect(render()).toContain('href="/profile-review"');
  });

  it("renders nodes as links, buttons or plain groups — never nested anchors", () => {
    const markup = render();

    // One real link (review), two real buttons (upload, parse), three groups.
    expect(countOf(markup, "<a ")).toBe(1);
    expect(countOf(markup, "<button")).toBe(2);
    expect(countOf(markup, 'role="group"')).toBe(4); // the row itself plus three nodes
  });

  it("makes no node a number", () => {
    const markup = render();

    // The only digits allowed are CSS utility values, so check the visible text
    // of each node instead of the markup as a whole.
    for (const label of markup.match(/aria-label="[^"]*"/g) ?? []) {
      const text = label.replace(/[^A-Za-z ]/g, "");

      expect(text).not.toMatch(/\b(step|no)\b/i);
      expect(label).not.toMatch(ariaLabelHasNumber());
    }
  });
});

describe("WorkflowGraph state", () => {
  it("renders every node idle by default", () => {
    const markup = render();

    expect(countOf(markup, 'data-status="idle"')).toBe(6);
  });

  it("applies the amber tone to a processing node and the green tone to a done one", () => {
    const markup = render(
      withStage(
        withStage(emptySnapshot(), "resume-upload", { status: "completed" }),
        "parse-profile",
        { status: "processing" }
      )
    );

    expect(markup).toContain("border-amber-500/70");
    expect(markup).toContain("border-emerald-500/60");
  });

  it("applies the red tone to a failed node", () => {
    const markup = render(
      withStage(emptySnapshot(), "resume-upload", {
        status: "failed",
        error: "The file could not be uploaded.",
      })
    );

    expect(markup).toContain("border-red-500/70");
    expect(markup).toContain("The file could not be uploaded.");
  });

  it("shows why the search stage failed instead of hiding it behind its label", () => {
    const markup = render(
      withStage(emptySnapshot(), "serpapi", {
        status: "failed",
        error: "The job search provider could not be reached. Try again shortly.",
      })
    );
    const serpapi = markup.slice(
      markup.indexOf('data-stage="serpapi"'),
      markup.indexOf('data-stage="process"')
    );

    // The reason has to be in the visible caption row, not only in the
    // accessible name — otherwise this node reads "GOOGLE JOBS" while the two
    // beside it explain themselves.
    expect(serpapi).toMatch(
      /text-\[13px\][^>]*>The job search provider could not be reached\. Try again shortly\.</
    );
    expect(serpapi).not.toContain("GOOGLE JOBS");
  });

  it("spells out the state in words, never in colour alone", () => {
    const markup = render(
      withStage(emptySnapshot(), "parse-profile", { status: "processing" })
    );

    expect(markup).toContain("running");
    expect(markup).toContain(">idle<");
  });

  it("marks an unavailable node unavailable without hiding it", () => {
    const markup = render();

    expect(countOf(markup, 'data-available="false"')).toBe(5);
    expect(countOf(markup, 'data-testid="workflow-node"')).toBe(6);
  });

  it("animates a wire only while its target is processing", () => {
    const idle = render();
    const flowing = render(
      withStage(
        withStage(emptySnapshot(), "resume-upload", { status: "completed" }),
        "parse-profile",
        { status: "processing" }
      )
    );

    expect(idle).not.toContain("jr-wire-signal");
    expect(flowing).toContain("jr-wire-signal");
  });

  it("hides the travelling dot from reduced-motion users", () => {
    const markup = render(
      withStage(
        withStage(emptySnapshot(), "resume-upload", { status: "completed" }),
        "parse-profile",
        { status: "processing" }
      )
    );

    expect(markup).toContain("motion-reduce:hidden");
  });
});

describe("WorkflowContent", () => {
  it("renders the workflow above the results area", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowContent, {}));

    expect(markup.indexOf('aria-label="Job Radar workflow"')).toBeLessThan(
      markup.indexOf("job-matches-heading")
    );
  });

  it("keeps job results out of the node row", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkflowContent, {
        results: createElement("p", null, "Senior Engineer — Acme"),
      })
    );
    const graph = markup.slice(0, markup.indexOf("job-matches-heading"));
    const results = markup.slice(markup.indexOf("job-matches-heading"));

    expect(graph).not.toContain("Senior Engineer");
    expect(results).toContain("Senior Engineer");
  });

  it("shows an honest empty state instead of fabricated matches", () => {
    expect(renderToStaticMarkup(createElement(WorkflowContent, {}))).toContain(
      "Matches appear here once the pipeline runs."
    );
  });

  it("disables Start Workflow and says why, while search is not connected", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowContent, {}));

    expect(markup).toContain("Start Workflow");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Job search is not connected yet.");
  });
});

/** Matches any digit directly inside an aria-label value. */
function ariaLabelHasNumber(): RegExp {
  return /aria-label="[^"]*\d[^"]*"/;
}
