# Job Radar — Engineering Report (demo-ready state)

Verification date: 2026-10-08. Every gate was run in this repository state and
recorded exactly as it passed. No claim below is inferred from an earlier run.

## A. Internship experience filtering

Source of truth: `src/lib/jobs/experience-filter.ts`
(`isExcludedByExperienceLevel(title, wantedLevel)`).

- Applies **only** when `wantedLevel === "internship"`; returns `false` for every
  other level, so entry/junior/mid/senior profiles are never touched by it.
- Word-boundary checks use padded-string `includes()` (no regex), so `sr.` and
  `head` behave as whole tokens.
- Excluded seniority keywords: senior, staff, principal, manager, director, head,
  vp, chief, expert, architect, `sr.` — and the special cases below.
- **Lead handling**: `Lead` is excluded only when the title does *not* also
  contain `intern` or `junior`. `"Intern, Lead Generation Team"` is preserved.
- **Roman numerals are not seniority**: III/IV/V are never auto-excluded.
- Only the job title is examined — never company, location, or description.

| Title | Wanted level: internship |
| --- | --- |
| Software Engineering Intern | keep |
| Backend Intern | keep |
| Intern, Lead Generation Team | keep |
| Junior Software Developer | keep |
| Student Developer | keep |
| Senior Software Engineer | exclude |
| Sr. Backend Engineer | exclude |
| Lead Software Engineer (no intern/junior in title) | exclude |
| Staff Software Engineer | exclude |
| Principal Engineer | exclude |
| Engineering Manager | exclude |
| Director of Engineering | exclude |
| Head of Engineering | exclude |
| VP Engineering | exclude |
| Chief Technology Officer | exclude |
| Software Architect | exclude |
| Engineer III / IV / V | keep |

`matching.ts` consumes the filter through the single imported call inside
`scoreJobs`. The scoring, freshness, salary, and dedupe logic are unchanged.

## B. Why the tests once failed (root cause, resolved)

`src/lib/jobs/matching.ts` had on-disk corruption, not a harness limitation:

1. A stray duplicate `isExcludedByExperienceLevel(job, wantedLevel)` nested
   inside `scoreJob`, and
2. an unclosed `/**` comment near the former line 226 that swallowed the rest of
   the file to EOF.

That produced the OXC/vitest parse error that the older version of this report
blamed on the harness. Both defects were repaired by line-based surgery
(418 → 356 lines) preserving every scoring function. The file now imports
`describeExperienceLevel` / `detectExperienceLevel` / `levelCompatibility` from
`@/lib/jobs/experience` and `isExcludedByExperienceLevel` from
`@/lib/jobs/experience-filter`. `npm run typecheck` is clean; there is **no**
outstanding OXC issue.

## C. Route → orchestrator delegation

`src/app/api/jobs/search/route.ts` is a thin delegate. It resolves the user id
(401 on identity problems), calls `searchJobsForUser(userId, { now })`
(`src/lib/jobs/search.ts`), and maps errors:

| Outcome | HTTP | Body signal |
| --- | --- | --- |
| Scan ran (partial scans included) | 200 | `{ jobs, metadata, attempts }` |
| Zero jobs after filtering | 200 | `jobs: []`, `failedSearchCount: 0` |
| Real provider failure | 502 | `error.code: "serpapi_unavailable"` |
| Rate limited | 429 | `serpapi_rate_limited` |
| Not configured | 503 | `serpapi_not_configured` |
| Profile store down/corrupt | 503 | `profile_unavailable` |
| No profile / roles / locations | 404 / 400 / 400 | `profile_not_found` etc. |

Every response is `no-store`. The provider-reachability message ("The job search
provider could not be reached. Try again shortly.") is produced only by the
`serpapi_unavailable` classification path in `src/lib/jobs/search.ts`, which
fires only when every attempt failed. A scan that succeeded and matched nothing
never produces it.

## D. Live SerpApi verification (this run)

Stored profile restored via real `PUT /api/profile`:
Profile A = Python Backend Developer / internship / Hyderabad / 7 days.

`GET /api/jobs/search` →
- 2 attempts, both `ok: true`, 0 failed:
  `"Python Backend Developer internship"`, `"Backend Developer Intern internship"`
- 23 raw → 18 final matches, all titles intern/junior tier:
  Backend Developer Intern, Node.js Backend Developer Intern, Python Developer
  Intern (Malkajgiri), Python Backend Intern, Backend Intern (Python), Backend
  Engineer Intern, Python Django Intern, Junior Full Stack Developer -
  Internship, Full Stack Developer Intern, React.js Developer - Intern, …
- No senior/lead/staff/principal/manager/director title survives the filter.

Earlier in the mission the two-profile proof ran against the same code path:
Profile B (Frontend Developer / junior / Bengaluru / 14 days) generated
`"Frontend Developer junior"` and returned junior/frontend titles, showing the
query, role, location, and level all change with the stored profile.

## E. Zero-result truthfulness (verified live)

SerpApi HTTP 200 + `search_metadata.status: "Success"` + provider text
`"Google hasn't returned any results for this query."` is reported as a **200**
answer with `jobs: []`, `failedSearchCount: 0`, and an empty `ok` attempt list —
never as a provider failure. The UI renders "Google Jobs returned no results for
this search." via `describeEmptyResult` (`src/components/job-results.tsx`).

## F. Navigation

`src/components/site-chrome.tsx` advertises Overview, Status, Resume, Profile,
Settings. All five resolve:

- `/` — Overview (workflow + results)
- `/api/health` — Status (live health JSON)
- `/resume` — Resume page (`src/app/resume/page.tsx`, hosts `ResumeUpload`)
- `/profile-review` — Profile (existing page)
- `/settings` — Settings page (`src/app/settings/page.tsx`, live profile
  preferences + service status)

`/resume` and `/settings` were created this pass; previously they 404'd. The
workflow keeps exactly six nodes (Resume Upload, Parse Profile, Review Profile,
SerpApi, Process, Job Matches).

## G. Gates (run in this final state)

| Gate | Result |
| --- | --- |
| `npx vitest run` | 541 passed (541), 32 files passed (32) |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | succeeds; routes include `/`, `/profile-review`, `/resume`, `/settings`, and all `/api/*` |

## H. Demo safety

- Real MongoDB + real SerpApi only. No fake, mock, or hardcoded jobs exist in any
  code path; the repository has an integration contract that returns errors
  instead of invented results.
- `.env.local` / `.env.production` (real `SERPAPI_API_KEY`, `MONGODB_URI`) are
  gitignored via `.env*` / `!.env.example`; `git ls-files` contains no `.env`
  file. Keys are never printed or logged.
- The current stored profile is Profile A, so the demo's first search produces
  real internship results immediately.
- Known non-blockers: the `con` entry in `git status` is a Windows
  reserved-device-name phantom (no file exists on disk) and cannot be committed.
  There is no uncommitted fix or mitigation still in progress.