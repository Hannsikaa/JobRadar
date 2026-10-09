"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";

import { readWorkflowReadiness, type WorkflowReadiness } from "@/lib/workflow/readiness";

/**
 * The landing page: what Job Radar is, why it is different, and the one action
 * that starts it — in the first screenful.
 *
 * It is a client component for one reason only: the primary action adapts to
 * what the visitor already has. A first-time visitor is pointed at the upload; a
 * visitor with a parsed profile is pointed at the review; someone already set up
 * is invited to run a scan. Everything else on the page is static and reads
 * identically on the server and the client.
 *
 * The page never claims a statistic it has not measured. The representative
 * result card is explicitly labelled "Example", uses a placeholder employer, and
 * carries no aggregate numbers.
 */

/** The four value blocks. */
const VALUES = [
  {
    title: "Resume-aware",
    body: "Your real skills, experience, and projects — parsed into a profile you can correct.",
  },
  {
    title: "Live listings",
    body: "Real Google Jobs results pulled at scan time, not a stale mirror of a database.",
  },
  {
    title: "Personalized ranking",
    body: "A transparent score built from six weighted signals, so the order means something.",
  },
  {
    title: "Explainable matches",
    body: "Every card names the signals that fired. No black-box “you might like this”.",
  },
] as const;

/** The four pipeline steps, in order. */
const STEPS = [
  { title: "Upload", body: "Add a PDF or DOCX resume." },
  { title: "Extract", body: "The parser turns it into a structured profile you review and edit." },
  { title: "Search", body: "Live Google Jobs, filtered to your freshness window and level." },
  { title: "Rank", body: "Matches are scored against the profile, with reasons and apply links." },
] as const;

/** The visible pipeline, used by the hero visual. */
const PIPELINE = ["Resume", "Extract", "Search", "Rank", "Matches"] as const;

export function Landing() {
  const readiness = useReadiness();
  const primary = primaryAction(readiness);
  const finalLabel = readiness?.reviewed ? "Continue to Workflow" : "Upload Resume";

  return (
    <div className="flex flex-col gap-20 pb-4 sm:gap-24">
      <section className="flex flex-col gap-8 pt-2">
        <div className="flex flex-col gap-5">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-300">
            <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            Live Google Jobs · ranked by fit
          </span>

          <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight text-zinc-50 sm:text-6xl">
            Find roles that actually fit you.
          </h1>

          <p className="max-w-2xl text-[15px] leading-relaxed text-zinc-400 sm:text-lg">
            Upload a resume. Job Radar reads it into a structured profile, searches live Google
            Jobs listings, and ranks every result against what you have — with the reason for each
            match shown, not guessed.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Link href={primary.href} className={PRIMARY_BUTTON}>
            {primary.label}
            <span aria-hidden="true">→</span>
          </Link>
          <a href="#how-it-works" className={SECONDARY_BUTTON}>
            See How It Works
          </a>
        </div>

        <p className="text-[13px] text-zinc-500">{primary.hint}</p>

        <PipelineVisual />
      </section>

      <section aria-labelledby="values-heading" className="flex flex-col gap-5">
        <h2 id="values-heading" className="sr-only">
          Why Job Radar
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {VALUES.map((value) => (
            <div
              key={value.title}
              className="flex flex-col gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-4"
            >
              <p className="text-[15px] font-semibold text-zinc-100">{value.title}</p>
              <p className="text-[13px] leading-relaxed text-zinc-400">{value.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section
        id="how-it-works"
        aria-labelledby="how-heading"
        className="flex scroll-mt-24 flex-col gap-6"
      >
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-400">
            How it works
          </p>
          <h2 id="how-heading" className="text-3xl font-semibold tracking-tight text-zinc-50">
            From resume to ranked matches
          </h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-zinc-400">
            Four steps, each reading what the previous one produced. Nothing is invented in
            between.
          </p>
        </div>

        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-4"
            >
              <span className="grid size-7 place-items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 font-mono text-[12px] font-semibold text-emerald-300">
                {index + 1}
              </span>
              <p className="text-[15px] font-semibold text-zinc-100">{step.title}</p>
              <p className="text-[13px] leading-relaxed text-zinc-400">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="preview-heading" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-400">
            The result
          </p>
          <h2 id="preview-heading" className="text-3xl font-semibold tracking-tight text-zinc-50">
            Every match comes with its reasons
          </h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-zinc-400">
            A score, the signals that produced it, the source the link came from, and one Apply
            button pointed at the most direct link the listing offered.
          </p>
        </div>

        <div className="mx-auto w-full max-w-md">
          <PreviewCard />
        </div>
      </section>

      <section className="flex flex-col items-start gap-4 rounded-3xl border border-[var(--border)] bg-[var(--surface)]/60 px-6 py-10 sm:items-center sm:text-center">
        <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">
          Start with the resume you already have.
        </h2>
        <p className="max-w-xl text-[15px] leading-relaxed text-zinc-400">
          Upload it once. Every search after that is ranked against the same profile.
        </p>
        <Link href={primary.href} className={PRIMARY_BUTTON}>
          {finalLabel}
          <span aria-hidden="true">→</span>
        </Link>
      </section>
    </div>
  );
}

const PRIMARY_BUTTON =
  "inline-flex items-center gap-2 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]";

const SECONDARY_BUTTON =
  "inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] px-5 py-2.5 text-sm font-semibold text-zinc-200 transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]";

/** Reads readiness once on mount, best-effort. */
function useReadiness(): WorkflowReadiness | null {
  const [readiness, setReadiness] = useState<WorkflowReadiness | null>(null);

  useEffect(() => {
    let active = true;

    void readWorkflowReadiness().then((value) => {
      if (active) {
        setReadiness(value);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  return readiness;
}

/**
 * The single next action for the visitor's current stage.
 *
 * While readiness is still unknown the first-visit action is shown, because it
 * is the only one that is never wrong for someone who has not set anything up
 * yet — and the page corrects itself the moment the read lands.
 */
function primaryAction(readiness: WorkflowReadiness | null): {
  href: string;
  label: string;
  hint: string;
} {
  if (readiness === null) {
    return { href: "/resume", label: "Get Started", hint: "Upload a resume to begin." };
  }

  if (readiness.reviewed) {
    return {
      href: "/workflow",
      label: "Continue to Workflow",
      hint: "Your profile is ready — run a fresh scan.",
    };
  }

  if (readiness.parsed) {
    return {
      href: "/profile-review",
      label: "Review your profile",
      hint: "Confirm what was extracted, then run the search.",
    };
  }

  if (readiness.hasResume) {
    return {
      href: "/workflow",
      label: "Continue setup",
      hint: "Your resume is on file — finish the workflow.",
    };
  }

  return { href: "/resume", label: "Get Started", hint: "Upload a resume to begin." };
}

function PipelineVisual() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/50 p-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-500">
        The pipeline
      </p>
      <ol className="flex flex-wrap items-center gap-2">
        {PIPELINE.map((stage, index) => (
          <Fragment key={stage}>
            <li className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5 text-[13px] font-medium text-zinc-200">
              <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              {stage}
            </li>
            {index < PIPELINE.length - 1 ? (
              <li aria-hidden="true" className="text-zinc-600">
                →
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>
    </div>
  );
}

/**
 * A representative result card.
 *
 * It mirrors the real card's hierarchy exactly, but uses a placeholder employer
 * and is labelled "Example" so it can never be mistaken for a real listing. The
 * controls are static spans rather than live links: this is a picture of the
 * product, not the product.
 */
function PreviewCard() {
  return (
    <figure className="flex flex-col gap-2">
      <div className="relative flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-5">
        <span className="absolute right-4 top-4 rounded-full border border-[var(--border)] bg-black/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
          Example
        </span>

        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-[19px] font-semibold leading-snug text-zinc-50">
              Senior Backend Engineer
            </p>
            <p className="text-[15px] text-zinc-300">Example Co.</p>
          </div>
          <PreviewMatchRing score={86} />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
          <span className="text-zinc-300">Remote</span>
          <span className="text-zinc-500">Age not stated</span>
          <span className="text-zinc-500">Salary not listed</span>
        </div>

        <ul className="flex flex-wrap gap-1.5">
          {["Skills overlap", "Seniority fit", "Remote role"].map((reason) => (
            <li
              key={reason}
              className="rounded-full border border-[var(--border)] bg-white/[0.04] px-2.5 py-1 text-[12px] text-zinc-300"
            >
              {reason}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--border)] pt-3">
          <span className="text-[13px] text-zinc-500">Company careers</span>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-[var(--border)] px-3 py-1.5 text-[13px] font-medium text-zinc-300">
              Mark applied
            </span>
            <span className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">
              Apply <span aria-hidden="true">↗</span>
            </span>
          </div>
        </div>
      </div>

      <figcaption className="text-center text-[12px] text-zinc-500">
        An illustrative card. Real results carry a live apply link and a score built from your
        profile.
      </figcaption>
    </figure>
  );
}

function PreviewMatchRing({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const circumference = 2 * Math.PI * 15.5;
  const dash = (clamped / 100) * circumference;

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div className="relative grid size-14 place-items-center">
        <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
          <circle
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            stroke="#34d399"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
          />
        </svg>
        <span className="text-xl font-semibold tabular-nums text-emerald-300">{score}</span>
      </div>
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        Match
      </span>
    </div>
  );
}
