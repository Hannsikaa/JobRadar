import type { ApplyOption, NormalizedJob } from "@/lib/jobs/types";

/**
 * Collapsing the same job that arrived several times.
 *
 * Duplication is expected, not exceptional: a user with three target roles and
 * two locations produces six searches, and the same listing routinely shows up in
 * more than one — and sometimes twice in one response, from two aggregator links
 * for the same requisition.
 *
 * Identity has two tiers:
 *
 * 1. **SerpApi's job id**, when present. Authoritative: it is Google's own
 *    identifier for the listing.
 * 2. **The deterministic fingerprint**, otherwise. Same job, same fingerprint,
 *    on every scan and across processes — which is what makes "new since last
 *    scan" honest.
 *
 * A job id is *not* allowed to hide a fingerprint collision: if two entries carry
 * different job ids but the same fingerprint, they are the same requisition
 * surfaced twice and are merged. That case is common enough on aggregator-fed
 * results that leaving it would produce duplicate cards for one job.
 */

/**
 * Removes duplicates, keeping the most complete version of each listing.
 *
 * "Most complete" is measured, not guessed: a listing with a description,
 * highlights, salary, and a direct apply link beats one with a title and nothing
 * else. Ties keep the earlier entry, so the order the user would expect from
 * Google's ranking survives.
 */
export function dedupeJobs(jobs: readonly NormalizedJob[]): {
  jobs: NormalizedJob[];
  removed: number;
} {
  const byId = new Map<string, NormalizedJob>();
  const fingerprintOwner = new Map<string, string>();

  for (const job of jobs) {
    // Tier 1: an existing entry under the same SerpApi id is the same listing.
    const existingId = byId.has(job.id) ? job.id : undefined;

    // Tier 2: an existing entry with the same fingerprint, whatever its id.
    const owner = fingerprintOwner.get(job.fingerprint);
    const existingFingerprint = owner !== undefined ? owner : undefined;

    const mergeTarget = existingId ?? existingFingerprint;

    if (mergeTarget === undefined) {
      byId.set(job.id, job);
      fingerprintOwner.set(job.fingerprint, job.id);
      continue;
    }

    const existing = byId.get(mergeTarget);
    if (existing === undefined) {
      // Should not happen; treat as a fresh entry rather than dropping data.
      byId.set(job.id, job);
      fingerprintOwner.set(job.fingerprint, job.id);
      continue;
    }

    const merged = mergeVersions(existing, job);
    if (merged !== existing) {
      byId.delete(mergeTarget);
      byId.set(merged.id, merged);
    }

    // Both ids now point at the same merged listing, so a third copy is caught
    // whichever key it arrives under.
    fingerprintOwner.set(job.fingerprint, merged.id);
    fingerprintOwner.set(existing.fingerprint, merged.id);
    if (merged.id !== job.id) {
      fingerprintOwner.set(job.fingerprint, merged.id);
    }
  }

  return { jobs: [...byId.values()], removed: jobs.length - byId.size };
}

/** How much of a listing is actually filled in. Higher wins a merge. */
export function completenessScore(job: NormalizedJob): number {
  let score = 0;

  score += job.company === undefined ? 0 : 1;
  score += job.location === undefined ? 0 : 1;
  score += job.description === undefined ? 0 : 2;
  score += job.salary === undefined ? 0 : 2;
  score += job.posted === undefined ? 0 : 2;
  score += job.applyUrl === undefined ? 0 : 2;
  score += job.highlights === undefined ? 0 : 1;
  score += job.publisher === undefined ? 0 : 1;
  score += job.detectedExperienceLevel === undefined ? 0 : 1;

  return score;
}

/**
 * Picks the better of two versions of the same job.
 *
 * On a tie the incumbent wins, which keeps Google's original ordering. Fields are
 * never merged field-by-field across the two versions: that would produce a
 * listing combining one source's salary with another source's link, which is a
 * job that never existed — with one exception, below.
 */
function pickRicher(a: NormalizedJob, b: NormalizedJob): NormalizedJob {
  return completenessScore(b) > completenessScore(a) ? b : a;
}

/**
 * Merges two records that are the *same* listing.
 *
 * The single exception to "never merge fields": the apply links. When one
 * publisher's copy carries the employer's own page and another carries only an
 * aggregator, the union preserves the verified destination so it can win the
 * apply selection, and keeps every original link as provenance. This is safe
 * precisely because the records share an identity key (a SerpApi job id or the
 * deterministic fingerprint), so the links describe one vacancy, not two.
 */
function mergeVersions(a: NormalizedJob, b: NormalizedJob): NormalizedJob {
  const winner = pickRicher(a, b);
  const applyOptions = mergeApplyOptions(a, b);

  if (applyOptions === undefined) {
    return winner;
  }

  return { ...winner, applyOptions };
}

function mergeApplyOptions(a: NormalizedJob, b: NormalizedJob): ApplyOption[] | undefined {
  const options: ApplyOption[] = [...(a.applyOptions ?? [])];

  for (const option of b.applyOptions ?? []) {
    if (!options.some((existing) => existing.url === option.url)) {
      options.push(option);
    }
  }

  return options.length === 0 ? undefined : options;
}