import type { AtsAdapter, DirectPosting } from "./types";
import { isRecord, readId, readString, readTimestamp } from "./util";

/**
 * Greenhouse board adapter.
 *
 * Verified interface: `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs`
 * returns `{ jobs: [{ id, title, absolute_url, location: { name }, updated_at,
 * first_published, company_name, requisition_id, ... }] }`. It is a documented,
 * public, read-only endpoint and needs no key.
 */

const BOARD_BASE = "https://boards-api.greenhouse.io/v1/boards";

export const greenhouseAdapter: AtsAdapter = {
  platform: "greenhouse",
  label: "Greenhouse",
  hosts: ["greenhouse.io"],
  boardUrl: (tenant) => `${BOARD_BASE}/${encodeURIComponent(tenant)}/jobs`,

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

      const title = readString(entry.title);
      const url = readString(entry.absolute_url) ?? readString(entry.url);
      const postingId = readId(entry.id);

      if (title === undefined || url === undefined || postingId === undefined) {
        continue;
      }

      const location = locationOf(entry.location);
      const updatedAt = readTimestamp(entry.updated_at);
      const publishedAt = readTimestamp(entry.first_published) ?? updatedAt;
      const companyName = readString(entry.company_name);

      postings.push({
        platform: "greenhouse",
        tenant,
        postingId,
        title,
        url,
        ...(location === undefined ? {} : { location }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(companyName === undefined ? {} : { companyName }),
      });
    }

    return postings;
  },
};

/** Greenhouse nests the location as `{ name }`, but tolerate a bare string. */
function locationOf(value: unknown): string | undefined {
  if (isRecord(value)) {
    return readString(value.name);
  }

  return readString(value);
}
