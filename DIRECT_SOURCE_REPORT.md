# Employer-Board Discovery — Implementation Report

**Date:** 2026-10-09
**Scope:** Employer-first job discovery from verified ATS boards, added alongside the
existing Google Jobs pipeline.
**Status:** Implemented, tested, and verified live in the browser. All work is
uncommitted on `main`.

This is a new report. The prior internship-filtering report (`REPORT.md`) and the
official-careers report (`OFFICIAL_CAREERS_REPORT.md`) are untouched, as is the
pre-existing `con` file.

---

## 1. The gap this closes

The existing pipeline discovers jobs through Google Jobs (via SerpApi) and then tries
to *verify* a destination for each listing. That is fundamentally a **verification**
pass: it can only ever talk about jobs a search engine already surfaced. If an
employer's board has 30 open roles and Google Jobs returned 3, the other 27 are
invisible — even though the employer is publishing them on a documented, public,
machine-readable endpoint.

Employer-board discovery is the other half: once a listing's own apply link has
*proven* which ATS board belongs to the employer, Job Radar can ask that board what
else is open right now, and match those postings to the user's target roles.

Concrete example from the live scan in §8: a Google Jobs result for Wayve surfaced a
handful of roles. Querying Wayve's verified Ashby board returned **157 open roles**,
of which **25 matched** the user's roles — jobs Google Jobs never returned.

---

## 2. Architecture (employer-first, evidence-gated)

The stage runs **after** search results are normalized and deduplicated, and
**before** freshness/salary/experience filters and scoring:

```
profile → plan → SerpApi (Google Jobs) → normalize → dedupe
        → ★ employer-board discovery (harvest → verify → fetch → match → map)
        → merge + re-dedupe
        → freshness → salary → experience → score → filter → results
```

The stage is built from three deliberate rules:

1. **No tenant guessing.** A board tenant is only ever taken from a URL that the
   provider actually returned (an apply option or `applyUrl` on a listing). There is
   no domain guessing, no crawling, and no "first result wins".
2. **Identity must be proven before a board is queried.** The harvested tenant is
   accepted only when `tenantMatchesEmployer` confirms the board belongs to the
   advertised employer. A familiar ATS hostname alone is *not* proof; a mismatched
   tenant is never chosen.
3. **Every failure is isolated and honest.** An adapter never throws; each board
   query resolves to a status (`ok | empty | not_found | rate_limited | unavailable |
   malformed`), and one board failing never erases another's results or breaks the
   scan.

### Modules

| File | Responsibility |
| --- | --- |
| `src/lib/jobs/ats/types.ts` | `AtsAdapter`, `DirectPosting`, `HttpGetter`, status enum |
| `src/lib/jobs/ats/util.ts` | Total readers for untrusted payloads (never throw) |
| `src/lib/jobs/ats/greenhouse.ts` | Greenhouse board adapter |
| `src/lib/jobs/ats/lever.ts` | Lever board adapter |
| `src/lib/jobs/ats/ashby.ts` | Ashby board adapter |
| `src/lib/jobs/ats/index.ts` | Adapter registry + shared `fetchBoard` (one HTTP path, one error model) |
| `src/lib/jobs/pool.ts` | Bounded `runPool` concurrency helper |
| `src/lib/jobs/direct-sources.ts` | Harvest, role-match, normalize, orchestrate, runner |

The applicant-tracking interfaces used here are all documented, public, read-only JSON
with no API key. No authentication or anti-bot mechanism is bypassed, and no page is
scraped as a primary path.

---

## 3. Supported boards (verified live, no key)

| Platform | Endpoint | Verified |
| --- | --- | --- |
| **Greenhouse** | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs` | yes |
| **Lever** | `https://api.lever.co/v0/postings/{token}?mode=json` | yes |
| **Ashby** | `https://api.ashbyhq.com/posting-api/job-board/{token}` | yes |

Each adapter is a pure `parse(payload, tenant)` plus a shared `fetchBoard` that owns
HTTP, timeouts, and status mapping. HTTP is injected via `HttpGetter`, which is what
makes the adapters testable without a network.

**Explicitly not adopted (and why):**

- **SmartRecruiters** — the documented public postings endpoint was probed and
  returned an empty set for the tenant tested. Not wired in until a live tenant
  returns real data; guessing would violate the no-fabrication rule.
- **Workday** — no reliable, supported, public JSON interface was verified, so it is
  not implemented. Workday boards are not scraped.

These are marked *unsupported*, not faked.

---

## 3.1 Adapter robustness fix (found during live verification)

A live scan reported Wayve's Ashby board as `malformed`, even though the endpoint
returns valid JSON (~3.3 MB, 157 jobs). Root cause: an **abort while the response body
was still streaming** surfaces inside `response.json()`, which the fetcher was mapping
to `malformed` — mislabelling a slow-but-valid large board as a bad payload.

Fixed in `src/lib/jobs/ats/index.ts`:

- The per-board timeout ceiling was raised from 12 s to 15 s (large boards).
- On a body-read failure, the fetcher now checks whether its own timeout signal
  fired: if so the status is `unavailable` ("timeout reading board"), otherwise
  `malformed`. A genuine timeout is no longer libelled as a corrupt response.

A regression test covers the distinction (`ats.test.ts`).

---

## 4. Verification & evidence (the destination model)

The stage reuses the existing single evidence model, `classifyDestination`, rather
than inventing a second one. That means:

- Only `verified_official_job` / `verified_employer_ats` may attach as an apply
  destination.
- Missing evidence stays `unverified` — never a fraud claim.
- Because a board posting comes *from* the employer's own verified board, it is
  inherently official; the later official-discovery stage skips it via
  `isOfficialJob`, so no redundant metered lookups are spent on it.

In the UI, a direct board posting renders as **"VERIFIED EMPLOYER ATS · via Ashby"**
with an **Apply ↗** button pointing at the exact `jobs.ashbyhq.com/...` URL the board
returned. Third-party and unverified destinations keep the weaker labels
("View listing" / "View original listing"), never "Apply".

---

## 5. Matching, normalization, dedup, and dates

- **Role match** (`postingMatchesRoles`): require role-family agreement when both
  sides have a family; otherwise fall back to a shared distinctive token (≥4 chars).
  This is what turns 157 Wayve openings into the 25 that actually fit the user's
  target roles.
- **Normalization** (`toNormalizedPosting`): maps a board posting into the existing
  `NormalizedJob` shape, reusing `buildFingerprint` for stable identity.
- **Stable id** (`directJobId`): `platform + tenant + posting id`, so a board posting
  keeps its identity across scans.
- **Dedup**: the merged set is re-deduplicated against Google Jobs results and
  against each other, so a job found both ways appears once and no verified URL is
  lost.
- **Dates**: `posted` is derived from `publishedAt ?? updatedAt`; ages over 365 days
  are treated as unknown. Publication date, last-updated, first-seen, and last-checked
  remain distinct — a missing date is never invented.

---

## 6. Budgets, caching, and configuration

The stage is bounded so a scan can never run away:

| Env var | Default | Range | Meaning |
| --- | --- | --- | --- |
| `DIRECT_SOURCE_MAX_TARGETS` | `5` | 0–25 | Boards queried per scan. `0` disables the stage. |
| `DIRECT_SOURCE_CONCURRENCY` | `3` | 1–8 | Parallel board requests. |
| `DIRECT_SOURCE_MAX_POSTINGS_PER_BOARD` | `25` | 0–200 | Matching postings kept from one board. |
| `DIRECT_SOURCE_MAX_TOTAL_POSTINGS` | `60` | 0–500 | Matching postings added to a scan in total. |

- **No extra SerpApi requests** are issued by this stage. It harvests tenants from
  URLs the Google Jobs results already returned, then talks only to the ATS boards.
- Board HTTP failures are isolated and produce secret-safe structured diagnostics;
  coverage is reported honestly and partially rather than silently shrinking.
- `.env.example` documents all four variables; `README.md` has the table and an
  employer-board paragraph. `.env.local` stays out of version control.

---

## 7. Tests and gates

- **715 tests / 44 files pass** (`npx vitest run`).
- `npx tsc --noEmit` — clean.
- `npx eslint` — clean.
- `npm run build` — succeeds; all routes compile.

New/extended coverage:

- `src/lib/jobs/ats/ats.test.ts` — each adapter's `parse` against fixtures; status
  mapping (`ok`, `empty`, `not_found`, `rate_limited`, `unavailable`, `malformed`);
  and the abort-vs-malformed regression.
- `src/lib/jobs/direct-sources.test.ts` — harvest, role match, mapping, runner,
  budgets, and failure isolation, all with injected HTTP (no live calls).
- `src/lib/jobs/search.test.ts` — the stage's position in the pipeline, merge +
  re-dedupe, duplicate accounting, and metadata fields.

No test ever calls SerpApi; the official-discovery stage is disabled in tests.

---

## 8. Live verification (browser, real data)

Run against the dev server at `http://localhost:3000`, using the app's own HTTP
endpoint (`GET /api/jobs/search`) with the same identity header the UI sends, for a
profile targeting "Software Engineer / Remote":

```
status 200
total jobs .................... 48
employer boards queried ....... 2   (both "ok")
direct-source jobs in result .. 33   (all verified_employer_ats)
```

Per-board coverage, as shown in the UI "Search details" disclosure:

```
Luma  · ashby · checked · 36 open,  13 matched your roles
Wayve · ashby · checked · 157 open, 25 matched your roles
```

A rendered result card (restored from the persisted scan):

```
Senior Software Engineer, Data
Wayve · 63 MATCH · London, United Kingdom · Remote · Posted 3d · Salary not listed
VERIFIED EMPLOYER ATS · via Ashby
[ Mark applied ]  [ Apply ↗ ]  → https://jobs.ashbyhq.com/wayve/3ef8fd28-…
```

The source filter defaults to **"Official & verified"** and offers "Include
third-party" and "All sources". This satisfies the acceptance criterion: a fresh scan
discovered postings directly from an employer board, with a verified original URL,
rendered with the correct badge and CTA.

---

## 9. Honest limits / not yet done

- **SmartRecruiters and Workday** are not implemented (see §3). No endpoints, tenants,
  or responses are fabricated.
- **Employer-registry persistence** (a durable, standalone employer → legal name →
  verified career domain → ATS tenant → evidence/timestamps/status record) is *not*
  added. Employer identity is verified per scan from provider-returned URLs; nothing
  is persisted as a registry document yet. This is the main remaining stage.
- **Freshness vocabulary** ("Newly discovered" / "First seen by Job Radar") builds on
  the existing first-seen tracking; no new date semantics were invented for direct
  postings beyond using the board's `publishedAt`.
- Worldwide-remote behaviour is unchanged and was not narrowed by this work.

---

## 10. Backward compatibility

- **API shapes:** unchanged. New metadata fields (`directSourceBoards`,
  `directSourcePostings`, `directSources`) and the widened `source` union are
  **optional/additive**, so older stored scans and existing constructors still parse.
- **Identity, resume, profile, and matching code** were not modified.
- The app remains usable when Mongo or an individual source is down: the stage
  degrades to statuses and the rest of the scan proceeds.
- A new count was made honest in the metadata: `directSourcePostings` reports the
  direct jobs **actually present in the final result** (after freshness/salary), while
  each `directSources[].matched` reports the board-level match count taken earlier —
  both are documented so the two numbers are not confused.

---

## 11. Files touched by this feature

- `src/lib/jobs/ats/{types,util,greenhouse,lever,ashby,index}.ts` (new)
- `src/lib/jobs/pool.ts` (new)
- `src/lib/jobs/direct-sources.ts` (new)
- `src/lib/jobs/types.ts` (`JobDiscoverySource`, `DirectSourceReport`, widened `source`,
  optional metadata)
- `src/lib/jobs/search.ts` (stage wiring, merge + re-dedupe, metadata)
- `src/lib/env.ts` (four `DIRECT_SOURCE_*` vars)
- `src/components/job-results.tsx` (employer-board coverage disclosure + board stat)
- `src/lib/jobs/ats/ats.test.ts`, `src/lib/jobs/direct-sources.test.ts`,
  `src/lib/jobs/search.test.ts` (new/extended tests)
- `.env.example`, `README.md` (docs)
