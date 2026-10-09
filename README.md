# Job Radar

Personalized job and internship discovery. Search runs through **SerpApi**,
matches are explained rather than compressed into a mystery score, results are
filtered by freshness with duplicates removed, and Job Radar **never applies to
anything on your behalf**.

## Stack

| Concern    | Choice                                        |
| ---------- | --------------------------------------------- |
| Framework  | Next.js 16 (App Router, Turbopack)            |
| Language   | TypeScript (strict)                           |
| Styling    | Tailwind CSS 4                                |
| Validation | Zod 4                                         |
| Database   | MongoDB (official driver, v7)                 |
| Jobs API   | SerpApi                                       |
| Tests      | Vitest 5 + `@vitest/coverage-v8`              |

## Getting started

```bash
npm install
cp .env.example .env.local   # optional: fill in values when you have them
npm run dev
```

Then open <http://localhost:3000> and
<http://localhost:3000/api/health>.

The app runs with **no** environment variables set. Missing optional services are
reported as `skipped` by the health endpoint instead of failing the boot.

## Environment variables

Copy `.env.example` to `.env.local` and fill in what you have. Every variable is
optional for local development.

| Variable                | Required | Default                 | Notes                                              |
| ----------------------- | -------- | ----------------------- | -------------------------------------------------- |
| `MONGODB_URI`           | no       | –                       | `mongodb://` or `mongodb+srv://`. Server-only.       |
| `MONGODB_DB_NAME`       | no       | `job_radar`             | Letters, digits, `_`, `-`.                           |
| `MONGODB_MAX_POOL_SIZE` | no       | `10`                    | Integer 1–100.                                      |
| `SERPAPI_API_KEY`       | no       | –                       | Server-only. Required before job discovery works.   |
| `SERPAPI_BASE_URL`      | no       | `https://serpapi.com`   | Server-only.                                        |
| `OFFICIAL_DISCOVERY_MAX_TARGETS` | no | `3`              | Bounded official-careers lookups per scan. `0` disables. |
| `OFFICIAL_DISCOVERY_CONCURRENCY` | no | `2`              | Parallel discovery lookups.                       |
| `OFFICIAL_DISCOVERY_CACHE_TTL_DAYS` | no | `7`           | Cache life for a verified destination.            |
| `OFFICIAL_DISCOVERY_NEGATIVE_TTL_HOURS` | no | `24`      | Cache life for "checked, found nothing".          |
| `DIRECT_SOURCE_MAX_TARGETS` | no    | `5`                     | Employer ATS boards queried per scan. `0` disables.  |
| `DIRECT_SOURCE_CONCURRENCY` | no    | `3`                     | Parallel board requests.                             |
| `DIRECT_SOURCE_MAX_POSTINGS_PER_BOARD` | no | `25`         | Matching postings kept from one board.              |
| `DIRECT_SOURCE_MAX_TOTAL_POSTINGS` | no | `60`             | Matching postings added to one scan in total.       |
| `NEXT_PUBLIC_APP_NAME`  | no       | `Job Radar`             | Inlined into the browser bundle at build time.       |

Official-careers discovery is a **bounded** enrichment stage. After the normal
scan it performs at most `OFFICIAL_DISCOVERY_MAX_TARGETS` distinct
employer+role+location web lookups — **one additional SerpApi request per
uncached target** — and caches each outcome in MongoDB (`job_discovery_destinations`,
with a TTL index). Repeat scans reuse the cache, and `OFFICIAL_DISCOVERY_MAX_TARGETS=0`
turns the stage off completely.

Employer-board discovery is the second, **key-free** enrichment stage. When a
listing the provider already returned carries an employer's verified ATS board
link (Greenhouse, Lever, or Ashby), Job Radar asks that board directly through its
public JSON API for every posting it advertises, and keeps the ones matching a
target role. This surfaces jobs a search never returned. A board is only queried
when the link proved the tenant belongs to the employer; a board that is down or
rate-limited is reported, never allowed to fail the scan. Set
`DIRECT_SOURCE_MAX_TARGETS=0` to turn the stage off.

Rules enforced in code by `src/lib/env.ts`:

- Blank or whitespace-only values are treated as **unset**, not as invalid.
- Secrets are parsed by a server-only schema. `getServerEnv()` throws if it is
  ever called in the browser, so a secret cannot silently reach a Client
  Component.
- Invalid values fail with a readable, per-variable error message instead of a
  stack trace deep inside a request.
- Parsed configuration is memoized; tests reset it via `__resetEnvCache()`.

## Health endpoint

`GET /api/health` returns `200` or `503` with a JSON body:

```jsonc
{
  "status": "degraded",                  // ok | degraded | error
  "timestamp": "2026-09-30T14:34:29.234Z",
  "checks": [
    { "name": "serpapi", "status": "skip", "detail": "SERPAPI_API_KEY is not configured" },
    { "name": "mongodb",  "status": "skip", "detail": "MONGODB_URI is not configured" }
  ]
}
```

| Status     | Meaning                                                  | HTTP |
| ---------- | -------------------------------------------------------- | ---- |
| `ok`       | Every dependency configured and reachable               | 200  |
| `degraded` | An optional dependency is not configured yet             | 200  |
| `error`    | A configured dependency is unreachable, or env is invalid | 503  |

The check never throws, and it never returns an API key. An unconfigured
database is a setup state, not an outage.

## Profile

### Model

`src/lib/profile/schemas.ts` is the single source of truth for a profile. It is
split into two schemas so the API validates each half and reports issues against
the payload the client actually sent (`resume.*` and `preferences.*`):

| Schema                  | Contents                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `resumeProfileSchema`    | `name`, `headline`, `summary`, `location`, `skills`, `links`, `education`, `experience`, `projects`, `certifications` |
| `jobPreferencesSchema`   | `targetRoles`, `locations`, `jobTypes`, `experienceLevel`, `minSalary`, `currency`, `freshnessDays` |

Rules enforced by the schemas:

- Unknown keys are stripped, so an unexpected field is dropped rather than stored.
- Strings and list entries are trimmed, blank entries are dropped, and exact
  duplicates are removed from every list.
- Missing collections default to `[]`, so the stored document is always complete.
- `minSalary` defaults to `null`; `currency` defaults to `USD`.
- Links accept `http` and `https` only. Other schemes (`javascript:`, `file:`,
  `mailto:`) are rejected.
- Years are integers between `1900` and `2999`, and `endYear` cannot precede
  `startYear`.
- Dates are kept as strings so an open-ended entry can say `Present`, `Current`,
  `Ongoing`, or `Now`. Full dates, `YYYY-MM`, `YYYY`, and `Month YYYY` are all
  accepted.

Enums:

| Field            | Values                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `experienceLevel`| `internship`, `entry`, `junior`, `mid`, `senior` (default `mid`)  |
| `freshnessDays`  | `1`, `3`, `7`, `14` (default `7`)                                 |
| `jobTypes`       | `full-time`, `part-time`, `contract`, `internship`, `freelance`   |

### Persistence

One profile per user is stored in the `profiles` collection, keyed by `userId`.
`src/lib/profile/collection.ts` creates a unique index named `userId_unique` on
`{ userId: 1 }` before the first write. Index creation is lazy, runs once per
process, and is **not** cached when it fails, so a database that was temporarily
unavailable is retried on the next write instead of staying broken until restart.

`src/lib/profile/repository.ts` owns all access:

| Function                      | Behaviour                                                                |
| ----------------------------- | ------------------------------------------------------------------------ |
| `validateProfile(input)`      | Validates and returns the normalized `{ resume, preferences }`, or throws `ProfileValidationError` |
| `createProfile(userId, input)`| Validates, inserts, returns the stored profile; duplicate `userId` throws `ProfileAlreadyExistsError` |
| `getProfileByUserId(userId)`  | Returns the profile, or `null` when none exists                          |
| `updateProfile(userId, input)`| Updates via `findOneAndUpdate` and returns the result; throws `ProfileNotFoundError` when nothing matched |

- `createdAt` is written once and never touched by an update; `updatedAt` moves
  on every write.
- Timestamps are stored as BSON dates and returned as ISO 8601 strings.
- Reads re-validate the stored document; if it no longer matches the schema the
  read throws `ProfileDataCorruptedError` rather than returning bad data.

Driver failures are translated at the repository boundary so nothing internal
escapes:

| Failure                              | Error                        | HTTP |
| ------------------------------------ | ---------------------------- | ---- |
| Schema mismatch                      | `ProfileValidationError`     | 400  |
| Missing or malformed identity header | `ProfileRequestError`        | 400  |
| No matching profile on update        | `ProfileNotFoundError`       | 404  |
| Duplicate key (`11000`)              | `ProfileAlreadyExistsError`  | 409  |
| Database unreachable                 | `ProfileStoreUnavailableError`| 503  |
| Any other driver failure             | `ProfileStoreError`          | 500  |
| Stored document fails re-validation  | `ProfileDataCorruptedError`  | 500  |

Messages are written for the caller and never contain driver output or connection
strings; the original error is preserved as `cause` for the server log.

### Profile endpoint

| Route                | Success            | Notes                                                        |
| -------------------- | ------------------ | ------------------------------------------------------------ |
| `GET /api/profile`   | `200` / `404`      | `404` with an error body when the user has no profile yet    |
| `PUT /api/profile`   | `201` created, `200` updated | A second create for the same user updates instead of failing |

```jsonc
// PUT /api/profile
{
  "resume":     { "name": "Ada", "skills": ["TypeScript", "MongoDB"] },
  "preferences": { "targetRoles": ["Backend Engineer"], "experienceLevel": "senior" }
}

// Validation failure
{ "error": { "code": "validation", "message": "Required", "issues": [ { "path": "resume.name", "message": "Required" } ] } }
```

Responses are never cached (`cache-control: no-store`), and the route is marked
`dynamic = "force-dynamic"`. A malformed JSON body, or valid JSON that is not an
object, returns `400` before any database work happens.

### Identity (not authentication)

The profile belongs to whoever sends `x-job-radar-user-id` (at most 128
characters, `[A-Za-z0-9._:@-]+`). When the header is missing, development and
test fall back to `local-user`; in production a missing header is a `400`
instead, so production traffic never shares one profile by accident.

> This header is a temporary stand-in for real authentication, not a security
> boundary. Anyone who can reach the app can send any id. Replace it with a
> verified session identity before exposing profiles to more than one person.

## Resume upload

`POST /api/resume` stores a PDF or DOCX file for the caller. Nothing is parsed
here; the file is stored as bytes with metadata so a later section can read it.

### Endpoint

| Route             | Success | Notes                                        |
| ----------------- | ------- | -------------------------------------------- |
| `POST /api/resume` | `201`  | Multipart only; no JSON/base64 payload        |

```bash
curl -X POST http://localhost:3000/api/resume \
  -H "x-job-radar-user-id: local-user" \
  -F "resume=@resume.pdf"
```

```jsonc
// 201
{
  "resume": {
    "id": "0f7c…",                    // UUID
    "originalFilename": "resume.pdf",  // sanitized for display
    "mimeType": "application/pdf",
    "extension": "pdf",
    "sizeBytes": 184320,
    "uploadedAt": "2026-09-30T14:34:29.234Z"
  },
  "profileLinked": true
}
```

`storageKey` and `userId` are deliberately absent — the on-disk location and the
owning user are server concerns. `profileLinked` is `false` when the user has no
profile yet, which is a normal order of operations, not an error.

### Validation

| Rule                | Value                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| Field               | `resume`                                                                     |
| Formats             | `.pdf` → `application/pdf`, `.docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Size limit          | 10 MB (`MAX_RESUME_SIZE_BYTES`)                                             |
| Filename            | Sanitized and capped at 200 characters; never used as a path                 |
| Content             | PDF must start with `%PDF-`; DOCX must be a ZIP container holding OOXML markers |

Content is checked, not just the declared extension: a file renamed to `.pdf` is
rejected unless its bytes actually look like a PDF.

> **Size limit caveat.** The runtime buffers a multipart part before the handler
> sees it, so the 10 MB limit is enforced *after* the body is read rather than
> while it streams. It bounds what is validated and stored, not the raw bytes a
> client can put on the wire. Bounding bytes in flight needs a proxy or a
> streaming parser, both out of scope here.

| Code                   | HTTP | Meaning                                      |
| ---------------------- | ---- | -------------------------------------------- |
| `invalid_request`      | 400  | Body is not multipart, or the identity header is bad |
| `missing_file`         | 400  | No file under the `resume` field             |
| `invalid_file`         | 400  | Empty, unreadable, or content check failed   |
| `file_too_large`       | 413  | Over 10 MB                                   |
| `unsupported_file_type`| 415  | Not an accepted format or MIME type          |
| `upload_failed`        | 500  | Something failed; nothing was kept           |
| `storage_unavailable`  | 503  | Storage or database unreachable              |
| `storage_failure`      | 500  | Reachable, but the operation failed          |

Errors use the same envelope as the profile route
(`{ "error": { "code": "...", "message": "..." } }`) with `cache-control: no-store`,
and never contain file contents, storage paths, driver output, or stack traces.

### Storage

`ResumeStorage` (`save` / `read` / `delete`) is the seam a different backend would
replace. The bundled local adapter writes to `.data/resumes/` — outside `src/` and
`public/`, and git-ignored. Keys are flat UUID names such as `<uuid>.pdf`; the
adapter rejects any key that is not one of those, confirms the resolved path stays
inside the root, and writes with `flag: "wx"` so an existing key is never
overwritten. `delete` is idempotent.

```ts
const storage = createLocalResumeStorage();
await storage.save(key, bytes); // throws ResumeStorageError / ResumeStorageUnavailableError
```

### Persistence and linkage

Metadata lives in the `resumeFiles` collection — `id`, `userId`,
`originalFilename`, `mimeType`, `extension`, `sizeBytes`, `storageKey`,
`uploadedAt` — with a unique `id_unique` index and a `{ userId: 1, uploadedAt: -1 }`
index named `userId_uploadedAt`.

A profile carries an optional top-level `resumeFileId`. Only
`setProfileResumeFileId()` writes it: client-submitted values are ignored and
profile updates never clear it. Uploading replaces the pointer and leaves earlier
files on disk.

### Upload order and rollback

```
validate → save bytes → insert metadata → link profile
```

Each step can fail after the bytes are written, so those failures roll back:
a metadata failure deletes the file, and a linkage failure deletes both the
metadata and the file. Cleanup is best-effort — it runs while another error is
already propagating, so the original cause stays the one the caller sees.

### UI

`src/components/resume-upload.tsx` picks a file, shows its name and size, and
reports the result. Its checks are a courtesy that avoids a pointless round trip;
the server re-runs every one of them, so nothing in the browser is a security
boundary.

## Project structure

```
src/
├── app/
│   ├── api/
│   │   ├── health/route.ts    # GET /api/health
│   │   ├── profile/route.ts   # GET + PUT /api/profile
│   │   └── resume/
│   │       ├── route.ts       # POST /api/resume
│   │       └── error-response.ts  # resume error envelope + logging
│   ├── error.tsx              # segment error boundary (uses retry)
│   ├── global-error.tsx       # root-layout fallback, self-contained <html>
│   ├── layout.tsx             # shared shell: fonts, metadata, header/footer
│   ├── not-found.tsx          # 404
│   └── page.tsx               # overview
├── components/
│   ├── resume-upload.tsx      # minimal upload control
│   └── site-chrome.tsx        # SiteHeader + SiteFooter
└── lib/
    ├── env.ts                 # Zod env validation (server + client schemas)
    ├── health.ts              # aggregate report + status roll-up
    ├── mongodb/
    │   ├── client.ts          # lazy cached singleton, pool settings
    │   └── health.ts          # read-only ping probe
    ├── profile/
    │   ├── schemas.ts         # resume + preference schemas and normalization
    │   ├── types.ts           # inferred input/domain types
    │   ├── errors.ts          # domain errors, HTTP statuses, cause chaining
    │   ├── collection.ts      # profiles collection + unique userId index
    │   ├── repository.ts      # create / read / update, error mapping
    │   └── user-id.ts         # temporary header identity shim
    ├── resume/
    │   ├── types.ts           # field name, limits, MIME + extension constants
    │   ├── errors.ts          # domain errors, HTTP statuses, cause chaining
    │   ├── selection.ts       # client-side extension/size checks (no I/O)
    │   ├── validation.ts      # filename, MIME, size, PDF/DOCX content checks
    │   ├── storage.ts         # ResumeStorage interface + local adapter
    │   ├── collection.ts      # resumeFiles collection + id/userId indexes
    │   ├── repository.ts      # metadata insert/read/delete, error mapping
    │   └── service.ts         # upload orchestration + rollback
    └── *.test.ts              # colocated unit tests
```

### MongoDB access

`src/lib/mongodb/client.ts` connects **lazily** — no socket is opened at import
time or during a build. The `MongoClient` is cached on `globalThis` so
development hot reloads do not leak connection pools, and the cache key includes
the URI so changing `MONGODB_URI` cannot reuse a client bound to the old host.

Data access goes through a repository layer rather than ad-hoc queries in
components. See **Profile → Persistence** above for the `profiles` collection,
its unique `userId` index, and the error mapping it applies; see **Resume
upload** for the `resumeFiles` collection and the binary storage seam.

## Scripts

| Script                    | Purpose                                  |
| ------------------------- | ---------------------------------------- |
| `npm run dev`             | Development server                       |
| `npm run build`           | Production build                         |
| `npm start`               | Serve the production build               |
| `npm run lint`            | ESLint                                   |
| `npm run typecheck`       | `tsc --noEmit`                           |
| `npm test`                | Vitest, single run                       |
| `npm run test:watch`      | Vitest in watch mode                     |
| `npm run test:coverage`   | Vitest with V8 coverage                  |

## Build status

Section 1 — Project Foundation — is complete: environment validation, folder
architecture, app shell and navigation, error boundaries, MongoDB connectivity,
the health endpoint, tests, and documentation.

Section 2 — Profile & Data — is complete: the validated profile model,
MongoDB-backed repository, `GET`/`PUT /api/profile`, unit tests, and
documentation.

Section 3 — Resume Upload — is complete: `POST /api/resume`, byte-level PDF and
DOCX validation, the replaceable `ResumeStorage` seam with a local adapter,
MongoDB metadata in `resumeFiles`, profile linkage via `resumeFileId` with
rollback on failure, the upload UI, unit tests, and documentation.

Section 4 — Resume Parsing — is complete: `POST /api/resume/parse`, PDF/DOCX text
extraction, text normalization, conservative structured parsing, Zod schema
validation, profile persistence, idempotent re-parsing, unit/integration/API
tests, and documentation.

SerpApi discovery, profile editing UI, authentication, matching, and the
discovery UI arrive in later sections.

## Resume Parsing

`POST /api/resume/parse` extracts structured information from a previously uploaded resume (PDF or DOCX) and persists it to the user's profile.

### Pipeline

```
Stored Resume File
        ↓
Retrieve File (ResumeStorage)
        ↓
Extract Raw Text (pdf-parse / mammoth)
        ↓
Normalize Text (line endings, blank lines, whitespace)
        ↓
Parse Resume Structure (section detection, conservative extraction)
        ↓
Validate with resumeProfileSchema (Zod)
        ↓
Persist to Existing Profile (profile repository)
```

### Supported Formats

- **PDF** — text extraction via `pdf-parse` (server-side, no browser dependency)
- **DOCX** — text extraction via `mammoth` (preserves paragraph boundaries)

### Endpoint

| Route | Success | Notes |
|-------|---------|-------|
| `POST /api/resume/parse` | `200` | JSON body with `resumeFileId` |

```bash
curl -X POST http://localhost:3000/api/resume/parse \
  -H "x-job-radar-user-id: local-user" \
  -H "Content-Type: application/json" \
  -d '{"resumeFileId": "3f6b1c2a-9d4e-4f80-b1a2-0c9d8e7f6a5b"}'
```

```jsonc
// 200
{
  "success": true,
  "profile": {
    "name": "Ada Lovelace",
    "headline": "Software Engineer",
    "summary": "Experienced developer...",
    "location": "San Francisco, CA",
    "skills": ["TypeScript", "React", "Node.js", "MongoDB"],
    "technologies": [],
    "languages": [],
    "education": [
      { "degree": "B.S. Computer Science", "school": "Stanford University", "fieldOfStudy": "Computer Science", "startYear": 2018, "endYear": 2022, "currentlyStudying": false }
    ],
    "experience": [
      { "title": "Software Engineer", "company": "Google", "location": "Mountain View, CA", "description": "Worked on search infrastructure", "startDate": "2022-06", "endDate": "Present", "currentlyWorking": true }
    ],
    "projects": [
      { "name": "Job Radar", "description": "Personalized job discovery platform", "technologies": ["Next.js", "TypeScript", "MongoDB"], "link": "https://github.com/adalovelace/job-radar" }
    ],
    "certifications": [
      { "name": "AWS Certified Cloud Practitioner", "issuer": "Amazon Web Services", "date": "2023", "credentialId": "ABC123", "link": "https://aws.amazon.com/verification" }
    ]
  },
  "warnings": []
}
```

### Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `invalid_request` | 400 | Malformed JSON, missing `resumeFileId`, or bad identity header |
| `no_resume_file` | 404 | No resume file exists for the given ID |
| `resume_text_extraction_failed` | 422 | File opened but contained no readable text (scanned/image-only PDF) |
| `resume_parse_failed` | 422 | Text could not be parsed into structured profile |
| `resume_validation_failed` | 422 | Parsed profile failed schema validation |
| `storage_unavailable` | 503 | Storage or database unreachable |
| `storage_failure` | 500 | Storage reachable but operation failed |
| `profile_not_found` | 404 | User has no profile to attach parsed resume to |
| `profile_update_failed` | 500 | Profile could not be updated |

Errors use the same envelope as other resume endpoints (`{ "error": { "code": "...", "message": "..." } }`) with `cache-control: no-store`, and never contain file contents, storage paths, driver output, or stack traces.

### Parsing Behavior

- **Conservative extraction** — prefers missing data over fabricated data; never invents facts
- **Deterministic** — same input always produces same output; no LLM or randomness
- **Section detection** — recognizes common heading variants (case-insensitive): Education, Skills, Experience, Projects, Certifications
- **Name extraction** — first non-heading, non-contact line in header
- **Skills** — comma/line-separated, categorized, deduplicated
- **Education** — degree, school, field, years, currently studying
- **Experience** — title, company, dates, description, technologies
- **Projects** — name, description, technologies, URL
- **Certifications** — name, issuer, date, credential ID, URL
- **Idempotent** — re-parsing replaces the profile with latest validated parse

### Security

- Extracted text treated as untrusted; never executed, evaluated, or logged in full
- Parser runs entirely server-side
- No raw document text exposed to client by default
- No raw document text persisted in MongoDB

### Architecture

```
src/lib/resume/parser/
├── types.ts          # Shared types (input, output, config)
├── errors.ts         # Domain errors with HTTP status codes
├── extraction.ts     # PDF/DOCX text extraction (pdf-parse, mammoth)
├── normalization.ts  # Text normalization + section splitting
├── structure.ts      # Conservative structured parsing
├── index.ts          # Main pipeline orchestration
└── *.test.ts         # Unit tests
```

### Tests

- Unit tests for extraction (PDF/DOCX), normalization, structure parsing
- Integration tests for full pipeline (stored file → extract → parse → validate → persist)
- API tests for `POST /api/resume/parse` (success, not found, extraction failure, parse failure, validation failure, DB failure, error envelope)

### Build Status

Section 4 — Resume Parsing — is implemented: `POST /api/resume/parse`, PDF/DOCX text extraction, text normalization, conservative structured parsing, Zod schema validation, profile persistence, idempotent re-parsing, unit/integration/API tests, and documentation. The commands in **Scripts** must all pass before this section is treated as verified.

SerpApi discovery, profile editing UI, authentication, matching, and the discovery UI arrive in later sections.

## Note on Next.js

`AGENTS.md` points at `node_modules/next/dist/docs/`. This project runs a recent
Next.js release whose APIs and conventions differ from older versions — read the
relevant bundled guide before changing framework code.