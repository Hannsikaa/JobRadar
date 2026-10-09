import type { ReactNode } from "react";

import { WorkflowConnection } from "@/components/workflow-connection";
import {
  JobMatchesIcon,
  ParseProfileIcon,
  ProcessIcon,
  ResumeUploadIcon,
  ReviewProfileIcon,
  SerpApiIcon,
} from "@/components/workflow-icons";
import { WorkflowNode } from "@/components/workflow-node";
import {
  deriveWorkflowNodes,
  deriveWorkflowWires,
  type WorkflowSnapshot,
  type WorkflowStage,
} from "@/lib/workflow/state";

/**
 * The workflow graph: six nodes joined by five separate wires.
 *
 * Presentational only. It takes a snapshot and renders it, which keeps it free
 * of fetch, timers and router state — and lets the tests assert the structure
 * directly.
 *
 * Layout: one horizontal pipeline on large screens, and a vertical stack on
 * small ones. The vertical form is the honest one for a phone — six stages can
 * be read top to bottom without a sideways scroll — while the horizontal form
 * keeps the pipeline shape where there is room for it.
 */

const STAGE_ICONS: Record<WorkflowStage, ReactNode> = {
  "resume-upload": <ResumeUploadIcon />,
  "parse-profile": <ParseProfileIcon />,
  "review-profile": <ReviewProfileIcon />,
  serpapi: <SerpApiIcon />,
  process: <ProcessIcon />,
  "job-matches": <JobMatchesIcon />,
};

/** Where the Review Profile node navigates. The profile editor lives there. */
const STAGE_HREFS: Partial<Record<WorkflowStage, string>> = {
  "review-profile": "/profile-review",
};

export type WorkflowGraphProps = {
  snapshot: WorkflowSnapshot;
  /** Runs a node's real operation in place (upload a resume, parse a resume). */
  onNodeActivate?: (stage: WorkflowStage) => void;
};

export function WorkflowGraph({ snapshot, onNodeActivate }: WorkflowGraphProps) {
  const nodes = deriveWorkflowNodes(snapshot);
  const wires = deriveWorkflowWires(nodes);

  return (
    <div
      role="group"
      aria-label="Job Radar workflow"
      className="overflow-x-auto pb-1"
      data-testid="workflow-graph"
    >
      <ol className="flex flex-col gap-0 lg:min-w-0 lg:flex-row lg:items-center">
        {nodes.map((node, index) => {
          const wire = wires[index - 1];
          const href = STAGE_HREFS[node.stage];
          const actionStages: WorkflowStage[] = ["resume-upload", "parse-profile"];
          const isActionable = onNodeActivate !== undefined && actionStages.includes(node.stage);

          return (
            // The wire is rendered immediately before its receiving node, which
            // is what puts exactly one connection in each of the five gaps.
            <li
              key={node.stage}
              className="flex min-w-0 flex-1 flex-col items-stretch lg:flex-row lg:items-center"
            >
              {wire === undefined ? null : <WorkflowConnection state={wire.state} />}
              <div className="min-w-0 flex-1">
                <WorkflowNode
                  node={node}
                  icon={STAGE_ICONS[node.stage]}
                  {...(href !== undefined
                    ? { href }
                    : isActionable
                      ? { onActivate: () => onNodeActivate?.(node.stage) }
                      : {})}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
