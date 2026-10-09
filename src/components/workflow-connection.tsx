import type { WorkflowWireState } from "@/lib/workflow/state";

/**
 * One connection between two adjacent nodes.
 *
 * There is exactly one of these per pair, rendered between the two boxes, so the
 * graph never draws one long line behind the whole pipeline. It is vertical when
 * the nodes stack (small screens) and horizontal when they run in a row (large
 * screens).
 *
 * The travelling dot is the only animation here, it is 4px, and it appears only
 * while a stage is actually processing. It stops entirely under
 * `prefers-reduced-motion`.
 */

export type WorkflowConnectionProps = {
  state: WorkflowWireState;
};

/** Colour of the wire line itself. */
export function wireLineClass(state: WorkflowWireState): string {
  switch (state) {
    case "flowing":
      return "bg-amber-500/70";
    case "settled":
      return "bg-emerald-500/50";
    case "failed":
      return "bg-red-500/60";
    default:
      return "bg-[var(--border-strong)]";
  }
}

export function WorkflowConnection({ state }: WorkflowConnectionProps) {
  return (
    <div
      // Decorative: direction is already conveyed by the node order and by the
      // status word on each node, so a screen reader gains nothing here.
      aria-hidden="true"
      data-testid="workflow-wire"
      data-wire-state={state}
      className="relative flex h-5 w-px shrink-0 items-center justify-center self-center lg:h-px lg:w-8 xl:w-12"
    >
      <div className={`h-full w-px lg:h-px lg:w-full ${wireLineClass(state)}`} />

      {/* Subtle direction cue at the receiving end, only where it reads as one. */}
      <span
        className={`absolute right-0 hidden size-1 rotate-45 border-r border-b lg:block ${wireChevronClass(state)}`}
      />

      {state === "flowing" ? (
        <span className="jr-wire-signal absolute top-1/2 left-0 hidden size-1 -translate-y-1/2 rounded-full bg-amber-300 motion-reduce:hidden lg:block" />
      ) : null}
    </div>
  );
}

function wireChevronClass(state: WorkflowWireState): string {
  switch (state) {
    case "flowing":
      return "border-amber-500/70";
    case "settled":
      return "border-emerald-500/50";
    case "failed":
      return "border-red-500/60";
    default:
      return "border-[var(--border-strong)]";
  }
}
