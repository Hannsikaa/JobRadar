import type { AtsAdapter, DirectPosting } from "./types";
import { isRecord, readId, readString, readTimestamp } from "./util";

/**
 * Ashby board adapter.
 *
 * Verified interface: `GET https://api.ashbyhq.com/posting-api/job-board/{token}`
 * returns `{ jobs: [{ id, title, location, secondaryLocations, publishedAt,
 * isRemote, workplaceType, jobUrl, applyUrl, isListed, employmentType, ... }] }`.
 * Documented, public, read-only; no key.
 */

const BOARD_BASE = "https://api.ashbyhq.com/posting-api/job-board";

export const ashbyAdapter: AtsAdapter = {
  platform: "ashby",
  label: "Ashby",
  hosts: ["ashbyhq.com"],
  boardUrl: (tenant) => `${BOARD_BASE}/${encodeURIComponent(tenant)}?includeCompensation=true`,

  parse(payload, tenant) {
    if (!isRecord(payload)) {
      return null;
    }

    const jobs = payload.jobs;
    if (!Array.isArray(jobs)) {
      return null;
    }

    const postings: DirectPosting[] = [];

    for (const entry of jobs) {
      if (!isRecord(entry)) {
        continue;
      }

      // An unlisted posting is not open to the public, so it is not a job the
      // user could apply to. Only an explicit `false` is treated as unlisted.
      if (entry.isListed === false) {
        continue;
      }

      const title = readString(entry.title);
      const url = readString(entry.jobUrl) ?? readString(entry.applyUrl);
      const postingId = readId(entry.id);

      if (title === undefined || url === undefined || postingId === undefined) {
        continue;
      }

      const location = readString(entry.location);
      const workplace = readString(entry.workplaceType);
      const remote =
        entry.isRemote === true ? true : workplace === undefined ? undefined : /remote/i.test(workplace);
      const publishedAt = readTimestamp(entry.publishedAt);
      const companyName = readString(entry.companyName) ?? readString(entry.organizationName);

      postings.push({
        platform: "ashby",
        tenant,
        postingId,
        title,
        url,
        ...(location === undefined ? {} : { location }),
        ...(remote === undefined ? {} : { remote }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        ...(companyName === undefined ? {} : { companyName }),
      });
    }

    return postings;
  },
};
