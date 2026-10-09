# SerpApi Google Jobs Integration

## 1. Purpose

Job Radar uses **SerpApi's Google Jobs API** as the actual job-discovery engine. SerpApi is not decorative or mocked — it is the live data source that powers the entire discovery pipeline.

**Data flow:**

```
Resume/Profile
    → user preferences (target roles, locations, experience level, freshness, salary)
    → Google Jobs search through SerpApi
    → job results (jobs_results)
    → processing (normalization, deduplication, freshness filtering, relevance scoring)
    → Job Matches
```

The six visible UI workflow nodes remain:

```
Resume Upload
      ↓
Parse Profile
      ↓
Review Profile
      ↓
SerpApi
      ↓
Process
      ↓
Job Matches
```

Normalization, deduplication, freshness filtering, and relevance scoring are implementation details inside **Process** — they are **not** separate visible workflow nodes.

---

## 2. API Engine

| Property | Value |
|----------|-------|
| **Engine** | `google_jobs` |
| **Base endpoint** | `https://serpapi.com/search.json` |
| **Required API key** | Yes — `api_key` parameter |
| **Output format** | JSON (default), also supports `html` and `md` |
| **Usage** | Server-side only |

**Endpoint pattern:**

```
https://serpapi.com/search.json?engine=google_jobs&q=<query>&location=<location>&api_key=<key>
```

---

## 3. Authentication

| Aspect | Rule |
|--------|------|
| **Environment variable** | `SERPAPI_API_KEY` |
| **Key type** | User's SerpApi private API key |
| **Location** | Server-side only — never in client bundle |
| **Exposure** | Never expose through client-side code, never commit to Git, never print in logs, never include in error messages |
| **Client prefix** | Never use `NEXT_PUBLIC_SERPAPI_API_KEY` |

The key is read via `getServerEnv()` in `src/lib/env.ts` and passed only to server-side API routes.

---

## 4. Request Parameters

Parameters relevant to Job Radar, derived from the SerpApi Google Jobs documentation.

### Required Parameters

| Parameter | Description | Job Radar Usage |
|-----------|-------------|-----------------|
| `engine` | Must be `google_jobs` | Hardcoded |
| `api_key` | SerpApi private key | From `SERPAPI_API_KEY` env var |
| `q` | Search query string | Built from profile `targetRoles` + keywords |

### Core Optional Parameters

| Parameter | Description | Job Radar Usage |
|-----------|-------------|-----------------|
| `location` | Geographic location (city-level recommended) | From profile `locations` |
| `hl` | Language code (e.g., `en`) | Default `en` |
| `gl` | Country code (e.g., `us`) | Default `us` |
| `google_domain` | Google domain (e.g., `google.com`) | Default `google.com` |
| `next_page_token` | Pagination token from previous response | Used for multi-page fetching |

### Advanced Google Jobs Parameters (from documentation)

| Parameter | Description | Status | Job Radar Usage |
|-----------|-------------|--------|-----------------|
| `chips` | Additional query conditions (deprecated by Google) | **Deprecated** | Do not use |
| `lrad` | Search radius in kilometers (does not strictly limit) | Optional | Not used initially |
| `ltype` | Filter by work from home (deprecated by Google) | **Deprecated** | Do not use |
| `uds` | Google-provided filter string from `filters` section | Optional | Not used initially |

### SerpApi-Specific Parameters

| Parameter | Description | Job Radar Usage |
|-----------|-------------|-----------------|
| `no_cache` | Force fresh fetch (default `false`) | Default `false` (use cache) |
| `async` | Submit and retrieve later via Searches Archive API | Not used (synchronous) |
| `zero_trace` | Enterprise only — skip storing search data | Not used |
| `output` | Response format: `json` (default), `html`, `md` | `json` |
| `json_restrictor` | Limit output fields for smaller payload | Not used initially |

---

## 5. Job Radar Query Construction

### From Profile → SerpApi Parameters

| Profile Field | SerpApi Parameter | Strategy |
|---------------|-------------------|----------|
| `targetRoles[]` | `q` | Join with `OR` or run multiple searches |
| `locations[]` | `location` | Run separate search per location, or join |
| `experienceLevel` | `q` / post-filter | Map to keywords (e.g., "entry level", "senior") |
| `freshnessDays` | `q` / post-filter | Use Google Jobs date filters via `q` (e.g., "since yesterday") or post-filter |
| `minimumSalary` | Post-filter | Not directly supported by Google Jobs API |
| `salaryCurrency` | Post-filter | Not directly supported |
| `jobTypes[]` | `q` / post-filter | Map to keywords (e.g., "full time", "contract") |
| `remoteOnly` | `q` / post-filter | Use "remote" keyword or post-filter |

### Important Distinction

| Category | Examples |
|----------|----------|
| **Directly supported by SerpApi/Google Jobs** | `q`, `location`, `hl`, `gl`, `google_domain`, `next_page_token`, date-posted filters via `q` |
| **Job Radar post-processing** | Salary filtering, deduplication, relevance scoring, experience-level matching, job-type matching, remote-only filtering |

**Do not pretend SerpApi supports a filter unless the source documentation confirms it.**

---

## 6. Request Example

**Safe example (no real API key):**

```text
https://serpapi.com/search.json?engine=google_jobs&q=software+developer&location=Hyderabad,+India&hl=en&gl=us&google_domain=google.com
```

**Conceptual request parameters:**

```json
{
  "engine": "google_jobs",
  "api_key": "<from SERPAPI_API_KEY>",
  "q": "software developer OR backend engineer",
  "location": "Hyderabad, India",
  "hl": "en",
  "gl": "us",
  "google_domain": "google.com"
}
```

---

## 7. Response Structure

Key response fields from the SerpApi Google Jobs documentation.

### Top-Level Fields

| Field | Description | Job Radar Usage |
|-------|-------------|-----------------|
| `search_metadata` | Search ID, status, timestamps, endpoints | Logging, debugging |
| `search_parameters` | Echo of request parameters | Verification |
| `jobs_results` | **Primary data** — array of job objects | Core processing |
| `filters` | Available filter categories (date posted, job type, etc.) | UI filter options (future) |
| `serpapi_pagination` | Pagination info (`next_page_token`, `next`) | Multi-page fetching |

### `search_metadata` Fields

| Field | Description |
|-------|-------------|
| `id` | Search ID inside SerpApi |
| `status` | `Processing` → `Success` or `Error` |
| `json_endpoint` | URL to retrieve JSON result |
| `created_at` / `processed_at` | Timestamps |
| `google_jobs_url` | Original Google Jobs URL |
| `raw_html_file` | Link to raw HTML |
| `total_time_taken` | Seconds |

### `serpapi_pagination`

| Field | Description |
|-------|-------------|
| `next_page_token` | Token for next page |
| `next` | Full URL for next page |

**Note:** The documentation states the `start` offset parameter has been discontinued by Google. Use `next_page_token` only.

---

## 8. Job Result Fields (`jobs_results[]`)

Fields available inside each job object, based strictly on the provided documentation.

### Core Fields (always present when available)

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Job title |
| `company_name` | string | Hiring company |
| `location` | string | Job location |
| `via` | string | Source site (e.g., "Indeed", "LinkedIn") |
| `share_link` | string | Google Jobs share URL |
| `description` | string | Full job description text |
| `extensions` | string[] | Brief highlights (e.g., "4 days ago", "Full-time", "$16.25–18.44 an hour") |
| `detected_extensions` | object | Structured metadata (see below) |
| `job_highlights` | object[] | Categorized highlights (Qualifications, Benefits, Responsibilities) |
| `apply_options` | object[] | Application links with title and URL |
| `job_id` | string | Encoded job identifier |
| `thumbnail` | string | Company logo / thumbnail URL (when available) |

### `detected_extensions` (structured metadata)

| Field | Type | Notes |
|-------|------|-------|
| `posted_at` | string | e.g., "4 days ago", "25 days ago" |
| `salary` | string | e.g., "16.25–18.44 an hour", "$20.50 USD per hour" |
| `schedule_type` | string | e.g., "Full-time", "Part-time", "Contractor" |
| `qualifications` | string | e.g., "No degree mentioned" |
| `work_from_home` | boolean | `true` when remote |
| `health_insurance` | boolean | |
| `dental_coverage` | boolean | |
| `paid_time_off` | boolean | |

**All `detected_extensions` fields are optional and may be absent.**

### `job_highlights`

Array of objects with `title` and `items[]`. Common titles:
- "Qualifications"
- "Benefits"
- "Responsibilities"

### `apply_options`

Array of objects with:
- `title` — source name (e.g., "Indeed", "LinkedIn", "ZipRecruiter")
- `link` — application URL

---

## 9. Pagination

| Aspect | Detail |
|--------|--------|
| **Token** | `next_page_token` from `serpapi_pagination` |
| **Usage** | Pass as `next_page_token` parameter in next request |
| **Page size** | Up to 10 results per page (documentation) |
| **Discontinued** | `start` offset parameter — do not use |

**Example flow:**

```text
Request 1 → response.serpapi_pagination.next_page_token → Request 2 (with token) → ...
```

---

## 10. Freshness

Job Radar supports: **1 day, 3 days, 7 days, 14 days**.

### Google Jobs / SerpApi Support

The documentation shows **date-posted filters** available via the `filters` section in responses, with options like:
- "Yesterday" → `q: "barista since yesterday"`
- "Last 3 days" → `q: "barista in the last 3 days"`
- "Last week" → `q: "barista in the last week"`
- "Last month" → `q: "barista in the last month"`

These are exposed as `uds` filter strings that can be passed to the API.

### Job Radar Strategy

| Approach | Detail |
|----------|--------|
| **SerpApi-side** | Use `uds` filter from `filters.date_posted` options when user selects freshness |
| **Job Radar post-filter** | Parse `detected_extensions.posted_at` (e.g., "4 days ago") and filter locally for precision |

**Do not claim a dedicated `freshness` parameter exists unless the source documentation supports it.** The documentation shows date filtering is done via `q`/`uds` query modifications.

---

## 11. Error Handling

### Error Scenarios & Responses

| Scenario | Detection | User-Facing Message |
|----------|-----------|---------------------|
| Missing `SERPAPI_API_KEY` | `getServerEnv()` returns undefined | "Job search is not configured. Please add a SerpApi key." |
| Invalid API key | SerpApi returns error status | "Job search service unavailable. Please try again later." |
| HTTP failure (timeout, 5xx) | `fetch` throws / non-2xx | "Job search request failed. Please try again." |
| Malformed response | JSON parse fails or missing `jobs_results` | "Job search returned unexpected data." |
| Empty `jobs_results` | Array length === 0 | "No jobs found for your criteria." |
| Rate/credit limit | SerpApi error response | "Search limit reached. Please try again later." |

### Security Rules for Errors

- **Never expose the API key** in error messages, logs, or responses
- **Never include raw SerpApi error details** that might contain the key
- Return generic, safe messages to the client
- Log detailed errors server-side only (without the key)

---

## 12. Security Rules

| Rule | Enforcement |
|------|-------------|
| API key is server-only | `getServerEnv()` throws in browser |
| Never use `NEXT_PUBLIC_SERPAPI_API_KEY` | Code review / lint |
| Never send key to browser | No client-side SerpApi calls |
| Never commit `.env*` files | `.gitignore` covers `.env*` |
| Never log the key | Structured logging without secrets |
| Never include in screenshots/demo | Operational discipline |
| Never place in README examples | Documentation review |

---

## 13. Job Radar Integration Architecture

```
Profile / Preferences
        ↓
Query Builder (targetRoles + locations + keywords)
        ↓
Server-side SerpApi Client (src/lib/serpapi/client.ts)
        ↓
Google Jobs API (https://serpapi.com/search.json)
        ↓
Raw jobs_results
        ↓
Normalization (standardize fields, parse salary, parse posted_at)
        ↓
Deduplication (by job_id, title+company+location)
        ↓
Freshness filtering (user-selected days vs detected_extensions.posted_at)
        ↓
Profile relevance (skills match, experience level, location match)
        ↓
Job Matches (display)
```

**Visible workflow nodes (unchanged):**

```
Resume Upload
      ↓
Parse Profile
      ↓
Review Profile
      ↓
SerpApi
      ↓
Process
      ↓
Job Matches
```

---

## 14. Rules for Future Implementations

1. **Use this document** before implementing any SerpApi feature.
2. **Use the original SerpApi documentation** (`Pasted markdown(20261004-190456).md`) as the authoritative API reference.
3. **Do not guess response fields** — only use fields documented here or in the source.
4. **Do not invent unsupported parameters** — if the source doesn't document it, don't use it.
5. **Do not expose API credentials** — ever.
6. **Keep SerpApi calls server-side** — no client-side fetch to SerpApi.
7. **Do not replace real SerpApi calls with mocks** in production application code.
8. **Keep the existing six-node workflow** — SerpApi remains the fourth visible node.
9. **Keep SerpApi explicitly visible** as "SerpApi / Google Jobs" in the workflow.
10. **Prefer small incremental implementations** with verification at each step.

---

## 15. Source Reference

| Item | Detail |
|------|--------|
| **Source file** | `Pasted markdown(20261004-190456).md` |
| **Source purpose** | SerpApi Google Jobs API documentation (playground, parameters, response examples) |
| **Note** | This document is a project-specific extraction/reference derived from that source. It contains no real API keys or secrets. |

---

## Verification Checklist

- [x] No real API keys or secrets included
- [x] No fabricated SerpApi fields or parameters
- [x] All parameters and fields traced to source documentation
- [x] Clear distinction between SerpApi-supported features and Job Radar post-processing
- [x] Security rules explicitly documented
- [x] Ready to be used as the reference for actual SerpApi implementation