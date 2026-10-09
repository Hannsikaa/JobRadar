import type { ReactNode } from "react";

import type { WorkflowNodeStatus, WorkflowNodeView } from "@/lib/workflow/state";

/**
 * One workflow node.
 *
 * A pipeline stage, not a dashboard card: an icon tile, the stage name, a state
 * pill, and one caption line. It is larger than the original dense variant so
 * the labels are legible at a glance, which is the whole point of the workflow
 * being the centrepiece.
 *
 * The node renders as one of three elements depending on what it can do —
 * `<a>` when it navigates (Review Profile), `<button>` when it performs real
 * work in place (upload, parse), and a non-interactive `<div>` otherwise. That
 * keeps keyboard access, focus rings and screen-reader semantics correct for
 * free instead of faking them on a clickable `<div>`.
 *
 * State is never communicated by colour alone. Every node carries a visible
 * status word (`idle` / `running` / `done` / `failed`) and a state dot, so the
 * four states are distinguishable in a screenshot, in high-contrast mode, and to
 * a screen reader.
 */

export type WorkflowNodeProps = {
  node: WorkflowNodeView;
  icon: ReactNode;
  /** Where the node navigates, for nodes that are really links. */
  href?: string;
  /** Runs the node's real operation, for nodes that are really buttons. */
  onActivate?: () => void;
};

/** Human-readable word for each state, also used by the tests. */
export const STATUS_WORDS: Record<WorkflowNodeStatus, string> = {
  idle: "idle",
  processing: "running",
  completed: "done",
  failed: "failed",
};

/** Border, background and glow for a node in a given state. */
export function nodeToneClass(status: WorkflowNodeStatus, available: boolean): string {
  if (!available && status === "idle") {
    return "border-[var(--border)] bg-[var(--surface)]/40";
  }

  switch (status) {
    case "processing":
      return "border-amber-500/70 bg-amber-500/[0.06] shadow-[0_0_16px_rgba(245,158,11,0.16)]";
    case "completed":
      return "border-emerald-500/60 bg-emerald-500/[0.05] shadow-[0_0_16px_rgba(16,185,129,0.14)]";
    case "failed":
      return "border-red-500/70 bg-red-500/[0.06] shadow-[0_0_16px_rgba(239,68,68,0.16)]";
    default:
      return "border-[var(--border-strong)] bg-[var(--surface-raised)]";
  }
}

/** Colour of the status word and the state dot. */
export function statusTextClass(status: WorkflowNodeStatus, available: boolean): string {
  if (!available && status === "idle") {
    return "text-zinc-400";
  }

  switch (status) {
    case "processing":
      return "text-amber-300";
    case "completed":
      return "text-emerald-300";
    case "failed":
      return "text-red-300";
    default:
      return "text-zinc-300";
  }
}

/** Background of the state dot, matching `statusTextClass`. */
export function statusDotClass(status: WorkflowNodeStatus, available: boolean): string {
  if (!available && status === "idle") {
    return "bg-zinc-600";
  }

  switch (status) {
    case "processing":
      return "bg-amber-400 animate-pulse";
    case "completed":
      return "bg-emerald-400";
    case "failed":
      return "bg-red-400";
    default:
      return "bg-zinc-400";
  }
}

/** Shared box: same size and spacing whether the node is a link, button or div. */
const boxClass =
  "flex w-full flex-col gap-1.5 rounded-xl border px-3.5 py-3 text-left transition-colors duration-200";

const interactiveClass =
  "hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] cursor-pointer";

export function WorkflowNode({ node, icon, href, onActivate }: WorkflowNodeProps) {
  const statusWord = STATUS_WORDS[node.status];
  const tone = nodeToneClass(node.status, node.available);
  const statusTone = statusTextClass(node.status, node.available);
  const dotTone = statusDotClass(node.status, node.available);

  // Same on all three render paths, so the tests can count nodes and read a
  // node's state without depending on which element it happens to be.
  const testProps = {
    "data-testid": "workflow-node",
    "data-stage": node.stage,
    "data-status": node.status,
    "data-available": node.available ? "true" : "false",
  };

  const iconTone = node.available ? "text-zinc-300" : "text-zinc-600";
  const labelTone = node.available ? "text-zinc-50" : "text-zinc-400";
  const captionTone = node.status === "failed" ? "text-red-300" : "text-zinc-400";

  // The caption line the node actually shows: the stage descriptor while idle,
  // anything the stage is doing/has done/failed at otherwise.
  const renderedCaption =
    node.status === "idle" && node.error === undefined
      ? (node.secondaryLabel ?? node.caption)
      : node.caption;

  const body = (
    <>
      <span className="flex items-start justify-between gap-2">
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-lg border border-white/[0.06] bg-white/[0.04] ${iconTone}`}
        >
          {icon}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-black/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${statusTone}`}
        >
          <span className={`size-1.5 rounded-full ${dotTone}`} aria-hidden="true" />
          {statusWord}
        </span>
      </span>

      <span className={`mt-1 block truncate text-[15px] font-semibold leading-tight ${labelTone}`}>
        {node.label}
      </span>

      {/*
        The stage descriptor ("GOOGLE JOBS") is a hint about what the stage is,
        not a report on it, so it only holds the line while the stage is idle.
        Anything the stage is doing, has done, or failed at replaces it — a
        failure on this node must never sit invisible behind a product name
        while its neighbours show the reason.
      */}
      <span className={`block truncate text-[13px] leading-tight ${captionTone}`}>
        {renderedCaption}
      </span>
    </>
  );

  // The nodes deliberately carry no `aria-label`: their accessible name is the
  // visible text (status word, stage name, caption), so what a screen reader
  // announces matches what is on screen. An `aria-label` that reorders or
  // reformats that text trips WCAG 2.5.3 "Label in Name".

  if (href !== undefined) {
    return (
      <a
        href={href}
        className={`${boxClass} ${tone} ${interactiveClass}`}
        {...testProps}
      >
        {body}
      </a>
    );
  }

  if (onActivate !== undefined) {
    return (
      <button
        type="button"
        onClick={onActivate}
        disabled={!node.available}
        aria-disabled={!node.available}
        className={`${boxClass} ${tone} ${interactiveClass} ${
          node.available ? "" : "cursor-not-allowed opacity-70"
        }`}
        {...testProps}
      >
        {body}
      </button>
    );
  }

  return (
    <div className={`${boxClass} ${tone}`} role="group" {...testProps}>
      {body}
    </div>
  );
}
