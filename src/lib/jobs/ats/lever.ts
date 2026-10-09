import type { AtsAdapter, DirectPosting } from "./types";
import { isRecord, readId, readString, readTimestamp } from "./util";

/**
 * Lever board adapter.
 *
 * Verified interface: `GET https://api.lever.co/v0/postings/{token}?mode=json`
 * returns a bare array of `{ id, text, categories: { location, allLocations,
 * team, commitment }, createdAt, hostedUrl, applyUrl, workplaceType, ... }`.
 * Documented, public, read-only; no key.
 */

const BOARD_BASE = "https://api.lever.co/v0/postings";

export const leverAdapter: AtsAdapter = {
  platform: "lever",
  label: "Lever",
  hosts: ["lever.co"],
  boardUrl: (tenant) => `${BOARD_BASE}/${encodeURIComponent(tenant)}?mode=json`,

  parse(payload, tenant) {
    if (!Array.isArray(payload)) {
      return null;
    }

    const postings: DirectPosting[] = [];

    for (const entry of payload) {
      if (!isRecord(entry)) {
        continue;
      }

      const title = readString(entry.text);
      const url = readString(entry.hostedUrl) ?? readString(entry.applyUrl);
      const postingId = readId(entry.id);

      if (title === undefined || url === undefined || postingId === undefined) {
        continue;
      }

      const categories = isRecord(entry.categories) ? entry.categories : {};
      const location = readString(categories.location) ?? firstOf(categories.allLocations);
      const workplace = readString(entry.workplaceType) ?? readString(categories.workplaceType);
      const remote = workplace === undefined ? undefined : /remote/i.test(workplace);
      const publishedAt = readTimestamp(entry.createdAt);

      postings.push({
        platform: "lever",
        tenant,
        postingId,
        title,
        url,
        ...(location === undefined ? {} : { location }),
        ...(remote === undefined ? {} : { remote }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      });
    }

    return postings;
  },
};

/** The first non-empty string in an array-valued field, or `undefined`. */
function firstOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    const found = readString(item);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}
