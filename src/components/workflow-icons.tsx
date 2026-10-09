/**
 * Small inline icons for the workflow nodes.
 *
 * The project has no icon dependency, and six small glyphs are not worth adding
 * one for. Every icon is 16px, stroked with `currentColor`, and marked
 * decorative: the node's own label and status word carry the meaning, so screen
 * readers are not given a nameless graphic.
 */

type IconProps = {
  className?: string;
};

const base = "size-4 shrink-0";

export function ResumeUploadIcon({ className = base }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L8 8m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

export function ParseProfileIcon({ className = base }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  );
}

export function ReviewProfileIcon({ className = base }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8l6 6v8a2 2 0 0 1-2 2h-2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.5 15 13l3.4-3.4a1.4 1.4 0 0 1 2 2L17 15l-3.5 1.5Z" />
    </svg>
  );
}

export function SerpApiIcon({ className = base }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m20 20-4.7-4.7M8 10.5h5M10.5 8v5" />
    </svg>
  );
}

export function ProcessIcon({ className = base }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M10 14v6" />
    </svg>
  );
}

export function JobMatchesIcon({ className = base }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" />
    </svg>
  );
}

/** Arrow used by the "Start Workflow" control. */
export function PlayIcon({ className = base }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 5.5 18 12 8 18.5v-13Z" />
    </svg>
  );
}