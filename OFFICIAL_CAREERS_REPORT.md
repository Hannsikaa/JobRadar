# Job Radar — Official-Careers Discovery Report

Verification date: **2026-10-09**. Gates and live checks below were run in this
repository state. Where a claim depends on a live provider result, the raw value
is quoted rather than summarized.

The problem this feature solves: a Google Jobs listing's apply links can name a
company, title, and destination that do **not** agree. Pinterest's listing once
carried a Granite (Workday) link; Home Depot's carried a Blue Origin Workday
link. Republisher boards (Indeed, Jobrapido, bebee, …) routinely outrank the
employer's own page. The fix is a bounded, evidence-based attempt to find the
employer's own job page — and to *never* claim "official" without proof.

---

## A. Root causes

1. **The listing is a candidate, not a fact.** Google Jobs aggregates from many
   sources and merges apply options from all of them. A single listing can carry
   apply links owned by unrelated employers (the Pinterest→Granite and
   Home-Depot→Blue-Origin failures). The old code had no reason to doubt them.
2. **The employer's own domain is often absent from the listing.** For many
   employers the provider returns only board links. No amount of URL
   classification can recover a domain that was never in the payload.
3. **Name resemblance is not ownership.** Ranking "official" by whether the URL
   looks like the company name fails exactly when the URL is a board slug.
4. **A recognized ATS is not automatically the employer's.** `ashbyhq.com`,
   `myworkdayjobs.com`, and friends host many tenants; a vendor match must still
   be checked against the *tenant*, or it becomes the Blue Origin failure again.

## B. Architecture

Three new modules, wired into the existing scan; nothing existing was rewritten.

| Module | Responsibility |
| --- | --- |
| `src/lib/jobs/official-careers.ts` | Pure decision: build the query, classify each result with the shared evidence model, choose at most one destination, or an honest non-attaching reason. |
| `src/lib/jobs/official-discovery.ts` | Bounded orchestration: pick targets, dedupe, honor the cache, bound concurrency, attach results. Also `buildOfficialDiscoveryRunner()` / `createOfficialDiscoveryRunner()`.
| `src/lib/jobs/official-cache.ts` + `collection.ts` | Mongo-backed best-effort cache with a TTL index.

Pipeline order in `search.ts`:

```
fetch (SerpApi google_jobs) → normalize → dedupe → freshness → salary floor
  → score → [official discovery: bounded, optional, error-swallowing]
  → markJobsSeen → withSourceEvidence
```

- Discovery runs **before** history is written and before the apply source is
  recorded, so a discovered destination is what gets persisted.
- `resolveOfficialDiscoveryRunner` returns `null` when discovery is off (no
  `SERPAPI_API_KEY`, or `OFFICIAL_DISCOVERY_MAX_TARGETS=0`), and the whole stage
  is skipped.
- Every discovery error is swallowed. A failed lookup can slow a scan but can
  never break it (proved live, see §G).
- The UI re-derives the displayed source from the job on every render
  (`selectJobSource`), so jobs persisted *before* this feature still classify
  correctly — enrichment is additive, not required.

## B.1. What was deliberately not done

No crawling, no page fetching, no domain guessing, no "first result wins", no
change to the SerpApi job plan, no new dependency, and no rewrite of scoring,
dedupe, freshness, salary, or the API contract.

---

## C. Domain resolution

- **No domain is ever guessed.** Discovery composes one query,
  `"<employer> <title> <location>"` (`buildOfficialQuery`), dropping
  `remote`/`anywhere`/`worldwide` locations. `MAX_QUERY_LENGTH = 220`.
- One call to the SerpApi **`google` web engine** (`searchWeb`, `num: 10`) per
  target. Only the provider's `organic_results` metadata (title, link, snippet)
  is used — the page is never fetched.
- **Every result is classified by the same `classifyDestination` the Apply
  button uses.** Discovery and the UI cannot disagree about what "official"
  means.
- Employer ownership is a **registrable-label** match (`hostOf` +
  `employer.ts`): `tech.loveholidays.com` → label `loveholidays` matches
  employer "loveholidays". Known boards rank third-party *before* any name
  resemblance, so a board whose slug happens to contain the company name is
  still third-party.
- A candidate that is a known ATS but whose tenant does not match the employer
  is remembered as a *foreign ATS* and is **never** returned.

## D. Exact-match verification

A result can become a destination only when **all** of these hold
(`evaluateCandidates`):

1. **(a) Employer-owned** — classified `official_company_site` or
   `verified_employer_ats`.
2. **(b) Title-consistent** — `titleMatchesJob`: the page title must name a role
   family, and it must equal the listing's family (`roleFamily` +
   `titlesAreConsistent`). A generic "Careers at Acme" names no family → never a
   job. If the listing itself names no family, a shared distinctive token
   (length ≥ 4) is required.
3. **(c) A posting, not a hub** — `looksLikeJobPosting` rejects bare
   `/careers`, `/jobs`, etc. (`LISTING_HOME_PATTERN`).
4. **(d) Location not conflicting** — `locationConflicts` compares country
   aliases between the listing and the page title/snippet and rejects a clear
   cross-country mismatch.

Only two outcomes attach a destination:

| Status | Attaches? |
| --- | --- |
| `verified_official_job` | yes |
| `verified_employer_ats_job` | yes |
| `employer_found_no_job` | no |
| `employer_mismatch` | no |
| `role_mismatch` | no |
| `location_mismatch` | no |
| `no_employer_domain` | no |
| `provider_error` | no |

Refinements that keep the reasons truthful:

- Only a page naming a **different role family** is `role_mismatch`. A generic
  "Pinterest Careers" page is `employer_found_no_job`.
- Seeing only a foreign employer's ATS posting is `employer_mismatch` — this is
  the exact failure the stage exists to prevent.

## E. Source categories and selection

`JobSourceKind` and the display order:

```
official_company_site  >  verified_employer_ats  >  third_party  >  unverified
```

- The **Sources** filter (`filter.ts`, client-side `<select id="jr-source">`):
  - `official` (default) → official + verified ATS
  - `third-party` → the above + `third_party`
  - `all` → everything (includes `unverified`)
  It is not counted by `countActiveFilters`, and changing it never re-triggers
  SerpApi (proved live, §H).
- **CTAs** match the badge exactly:
  - official / verified ATS → **Apply**
  - third_party → **View listing**
  - unverified → **View original listing**
- Each card has a **"Why this source?"** disclosure that prints the
  classification evidence *and* the discovery status plus the honest "checked
  <date>" stamp.

## F. Provider-call limits and caching

- **Cost:** exactly **one additional SerpApi request per uncached target**
  (`google` web engine, `num: 10`). The existing `google_jobs` plan is
  unchanged.
- **Bound:** `OFFICIAL_DISCOVERY_MAX_TARGETS` (default `3`, schema max `25`;
  `0` disables). The env schema caps it so no configuration can make a scan
  unbounded, and `selectDiscoveryGroups` treats a non-finite limit as off, never
  unlimited.
- **Deduplication** by cache key `employerSlug|normalizeName(title)|normalizeName(location)`.
  One lookup serves every listing that shares it. Official jobs are skipped.
  Remaining jobs are ordered by relevance score, then sliced to the budget.
- **Concurrency** `OFFICIAL_DISCOVERY_CONCURRENCY` (default 2) via a fixed-size
  worker pool.
- **Cache** (`job_discovery_destinations`, TTL index `expiresAt_ttl`
  `expireAfterSeconds: 0`):
  - verified destination → `OFFICIAL_DISCOVERY_CACHE_TTL_DAYS` (default 7)
  - negative/neutral → `OFFICIAL_DISCOVERY_NEGATIVE_TTL_HOURS` (default 24)
  - best-effort: a read miss or DB failure degrades to "look it up again"; a
    write failure is ignored. Cached by employer+role, never by URL, so an
    incorrect match cannot be retrieved under another employer's key.

The added per-scan budget is therefore: **existing job pages + ≤ `maxTargets`
web lookups** (minus any cache hits).

## F.1. Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `OFFICIAL_DISCOVERY_MAX_TARGETS` | `3` | `0` disables the stage. Capped at 25. |
| `OFFICIAL_DISCOVERY_CONCURRENCY` | `2` | Parallel lookups. |
| `OFFICIAL_DISCOVERY_CACHE_TTL_DAYS` | `7` | Verified-destination lifetime. |
| `OFFICIAL_DISCOVERY_NEGATIVE_TTL_HOURS` | `24` | "Checked, found nothing" lifetime. |

Discovery is also off whenever `SERPAPI_API_KEY` is unset, so tests never touch
the network.

---

## G. Real verification examples (live, 2026-10-09)

Live scans against the dev server at `http://localhost:3000` via
`GET /api/jobs/search` (header `x-job-radar-user-id`), plus DOM inspection of
`/workflow`. Three profiles were scanned.

### Positive: employer's own domain

**loveholidays — "Senior Software Engineer (Customer Platform)"**

- Original apply options (from Google): only
  `https://app.welcometothejungle.com/jobs/LuFjV6MZ…` (a republisher).
- Discovery outcome: `verified_official_job`.
- Attached destination (now first in `applyOptions`):
  `https://tech.loveholidays.com/bootcamp-grad-to-software-engineer-e4ddd0bec23`
- Evidence:
  - `Found on tech.loveholidays.com, the employer's own domain.`
  - `Page title "Bootcamp grad to Software Engineer" matches "Senior Software Engineer (Customer Platform)".`
- Why it won: it is on the employer's registrable domain, and the title check
  passed. It outranks the third-party republisher. The rendered card shows
  **OFFICIAL COMPANY CAREERS**, "via tech.loveholidays.com", CTA **Apply**.
  (Caveat in §I.)

### Positive: recognized ATS (tenant matched)

- **Wayve** — `jobs.ashbyhq.com/wayve/…` → `verified_employer_ats` (via Ashby).
- **Luma — "Software Engineer, Inference"** —
  `jobs.ashbyhq.com/lumaai/c35da9e1…` → `verified_employer_ats` ("Ashby board
  \"lumaai\" matches the employer 'Luma'").
- **AVEVA Solutions — "Principal Cloud Software Engineer"** →
  `aveva.wd3.myworkdayjobs.com/AVEVA_careers/…` (`verified_employer_ats`, via
  Workday).

These three already carried a verified destination in the original listing, so
discovery **skipped** them (`officialDiscovery = null`) — it does not spend
budget re-learning what it already knows.

### No direct page found

**Qualcomm — "Senior Software Engineer – Virtual Platforms - Qualcomm -
Cambridge, UK"**: original options are all boards (Indeed, Experteer, Glassdoor,
StudySmarter, Jobrapido). Outcome `no_employer_domain`
("No page that could be tied to Qualcomm was found."). The job keeps its
third-party destination and shows "View listing".

### Deliberately mismatched employer / ATS

**Kohl's** (Backend Engineer profile): discovery saw an employer-specific ATS
posting belonging to a *different* employer → `employer_mismatch`
("The only employer-specific posting found belongs to a different employer.").
The foreign posting was **not** attached.

### Provider failure still renders

**ReactWise — "Front-End Software Engineer (React/Typescript)"**: the web lookup
threw → `provider_error` ("The official-careers lookup could not be completed.").
The job was still returned, scored, and rendered with its original Y Combinator
link. This is the graceful-degradation guarantee, observed live rather than
simulated.

### Third-party-only listings

Many listings (iCapital, Hostaway, Hunter Bond, YO AI Labs, Rheinmetall,
Scale, …) survived with only board destinations. They remain visible under the
`third-party`/`all` filters with a "View listing" CTA.

### Cache

After the first scan, `job_discovery_destinations` contained 2 documents with
negative outcomes, each `expiresAt = resolvedAt + 24h` (e.g.
`dsconsultingservices|python developer intern malkajgiri|rangareddy telangana`,
status `no_employer_domain`). This confirms the negative TTL and the
employer|role|location key.

### Opening the selected destinations

Each rendered card's `Apply`/`View listing` href is exactly the selected
destination. Fetching the selected URLs confirmed:

| Selected destination | Result |
| --- | --- |
| `jobs.ashbyhq.com/wayve/3ffe6272-…` | **200**, page title `Software Engineer, Fleet Management @ Wayve` — exact role confirmed |
| `aveva.wd3.myworkdayjobs.com/AVEVA_careers/…` | **200** (JS-rendered SPA; empty static title) |
| `www.indeed.com/viewjob?jk=…` (Qualcomm, third-party) | 401 "Authenticating…" — board bot wall, expected for a board |
| `tech.loveholidays.com/bootcamp-grad-to-software-engineer-…` | **403** Cloudflare "Just a moment…" — see §I |

The Wayve result is the cleanest confirmation: the ATS URL renders the exact
job title that discovery matched. The loveholidays URL is reachable in a real
browser but was blocked for the automated fetch, and is discussed honestly in
§I.

---

## H. UI + gates

### Live UI (DOM / accessibility, no screenshots available)

Rendered on `/workflow` for the Software Engineer scan (15 matches):

- Sources filter present; counts when toggled:
  `official = 4`, `third-party = 12`, `all = 15`. Total cards = 15.
- Badge/CTA tally under `all`:
  - `official [Apply]` × 1
  - `verified ATS [Apply]` × 3
  - `third-party [View listing]` × 8
  - `NOT VERIFIED [View original listing]` × 3
- The loveholidays "Why this source?" disclosure rendered:
  `Host tech.loveholidays.com matches the employer name "loveholidays".`
  followed by `Found this role on the employer's own site. · checked 2026-10-09`.
- Changing the Sources select produced **no** `serpapi` or `/api/jobs/search`
  request (network list empty for those patterns) — filtering is purely
  client-side.

### Gates (run in this state)

| Gate | Result |
| --- | --- |
| `npm test` | **685 passed / 42 files** |
| `npm run typecheck` | clean (no output) |
| `npm run lint` | clean (0 errors, 0 warnings) |
| `npm run build` | succeeded (Next 16.3.7, Turbopack) |

---

## I. Known limitations (honest)

1. **Coarse role-family matching can accept a related-but-different page — the
   weakest observed case.** The loveholidays example: a page titled "Bootcamp
   grad to Software Engineer" was accepted for "Senior Software Engineer
   (Customer Platform)" because both share the software family, and the URL sits
   on the employer's own `tech.` subdomain behind a Cloudflare challenge (the
   automated fetch returned 403 "Just a moment…"). The destination *is* on the
   employer's own domain, so the user still lands at the employer rather than a
   board — but it may be a careers article rather than the exact requisition.
   Tightening this safely requires either fetching the page (which this design
   forbids, and which would also hit the bot wall) or a stricter title/seniority
   model. It is left as a documented limitation rather than a risky last-minute
   heuristic.
2. **`looksLikeJobPosting` accepts a single non-hub path segment.** A careers
   article at `/some-article` looks like a posting; only `/careers`-style hubs
   are rejected.
3. **Provider flakiness is not retried within a scan.** ReactWise failed once
   and was cached negative for 24h. A second scan reuses that negative until it
   expires.
4. **Coverage per scan is bounded by design.** At most `maxTargets` distinct
   lookups; most listings in a single scan remain third-party or unverified.
   Discovery improves the *best* listings, it does not make every listing
   official.
5. **No liveness check.** Discovery trusts search metadata; it does not confirm
   the page still exists or still advertises the role.
6. **Screenshots could not be captured** (no visible desktop window in the
   environment); the UI was verified through the live DOM/accessibility tree.
7. The untracked file `con` at the repository root is a **pre-existing** phantom
   artifact, not produced by this work, and was left untouched.

---

## J. Changed files and configuration

**New source**

- `src/lib/jobs/official-careers.ts` (+ `official-careers.test.ts`)
- `src/lib/jobs/official-discovery.ts` (+ `official-discovery.test.ts`)
- `src/lib/jobs/official-cache.ts` (+ `official-cache.test.ts`)

**Modified source**

- `src/lib/jobs/types.ts` — `JobSourceKind`, `OfficialDiscoveryStatus`/`Summary`,
  `officialDiscovery`.
- `src/lib/jobs/apply-source.ts` — `provider` field, `knownAtsName`.
- `src/lib/jobs/employer.ts` — ownership/role helpers used by discovery.
- `src/lib/jobs/collection.ts` — `job_discovery_destinations` collection +
  TTL index + accessors.
- `src/lib/jobs/env.ts` — the four `OFFICIAL_DISCOVERY_*` fields.
- `src/lib/serpapi/client.ts` — `searchWeb` / `GOOGLE_ENGINE`.
- `src/lib/jobs/search.ts` — enrichment wiring, failure isolation.
- `src/lib/jobs/filter.ts` — the source filter.
- `src/lib/jobs/dedupe.ts` — union apply options so a discovered destination is
  not lost when duplicates merge.
- `src/components/job-results.tsx` — badge, filter, CTA, "Why this source?".
- Tests: `search.test.ts`, `job-card.test.ts` (+ the three new suites).

**Docs / config**

- `.env.example` — documents the four variables and the one-request-per-target
  cost.
- `README.md` — env table rows + a bounded-discovery note.

**Database**

- `job_discovery_destinations` collection with a TTL index on `expiresAt`.

**Not changed:** API response shape (`{jobs, metadata, attempts}` /
`{result:{jobs,metadata,attempts}}`), SerpApi job plan, scoring, freshness,
experience filter, salary filter, resume/profile flows, identity contract.

---

## K. Reproduction steps

1. `npm install`
2. `cp .env.example .env.local`, then set `MONGODB_URI` and `SERPAPI_API_KEY`.
   (Optional: tune `OFFICIAL_DISCOVERY_*`.)
- `npm run dev`, then open `http://localhost:3000`.
- The browser mints a user id in `localStorage` (`job-radar:user-id`). To reuse
  an existing profile, run one search in the UI first.
- HTTP equivalent:

  ```sh
  curl -H "x-job-radar-user-id: <user-id>" http://localhost:3000/api/jobs/search
  ```

- In `/workflow`, use the **Sources** dropdown (Official & verified →
  Include third-party → All sources) and expand a card's **Why this source?**
  to see the classification evidence and the discovery status with its checked
  date.
- To disable the stage entirely, set `OFFICIAL_DISCOVERY_MAX_TARGETS=0` (the
  pipeline then runs exactly as before, with no web lookups and no cache
  writes).

### Reproduce the gates

```
npm test
npm run typecheck
npm run lint
npm run build
```
