# Job Radar — Final Product Redesign Report

Verification date: 2026-10-09. Every gate and every live browser check below was
run against this working tree in its final state. Nothing is inferred from an
earlier run; failures and limitations are recorded as found.

---

## 1. Verdict

The product redesign is complete and demo-ready. The Workflow is the visual
centrepiece, the job results are a real payoff, the Resume/Profile/Settings
surfaces are usable, and the two P0 defects are fixed. All four quality gates
pass, and the full live flow — upload → parse → review → SerpApi → process →
matches — was driven in a real browser against real MongoDB and real SerpApi.

| Axis | Result |
| --- | --- |
| `npm test` | 33 files, **548 passed (548)** |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | success, 12 routes |
| Lighthouse `/` | Accessibility **1.00**, Best Practices **1.00**, SEO **1.00**, 0 failing audits |
| Lighthouse `/profile-review` | Accessibility **1.00**, Best Practices **1.00**, SEO **1.00**, 0 failing audits |
| Live SerpApi scan | 2/2 searches, 39 raw, 0 duplicate, **24 matches** |

---

## 2. What changed vs. what was preserved

**Changed (UI/UX only):** page chrome and typography, navigation, the workflow
centre, the job-results payoff, the Profile Review workspace, resume upload,
settings, error/empty/loading states, design tokens and motion.

**Preserved untouched:** the matching/scoring algorithm, the resume parser, the
SerpApi query builder and its non-geographic-location omission, the dedup and
freshness logic, the MongoDB schema and repositories, all API contracts and
status codes, and the existing 548-test suite (only two render assertions were
updated to match the new responsive markup; no behavioural test changed).

---

## 3. P0 — Languages / Target Roles typing bug (fixed)

**Root cause.** The old field was fully controlled through a lossy round trip:
`value={listToText(list)}` with `onChange={textToList}`. `textToList("English,")`
drops the trailing comma and `textToList("English ")` trims the trailing space,
so the separator vanished before the next word could be typed. Typing
`English, Spanish, Hindi` was impossible.

**Fix.** New `src/components/list-input.tsx`. It keeps the *raw* string in local
state while focused, normalizes only on blur, still streams the parsed array up
on every keystroke (so validation and the saved payload stay live), and never
lets the display re-derive itself out from under the caret.

**Extra hardening found during browser testing.** The first cut re-synced from the
prop whenever the field was unfocused, which an upstream re-render could race.
It now compares the incoming serialized list against what this field last emitted
(`listToText(value)` vs. its own echo), so an external normalisation still lands
but an in-progress edit can never be clobbered — regardless of focus timing.

**Verified in a real browser** (native-setter + `input` event, the exact React
`onChange` path), character by character:

| Field | Typed | Result |
| --- | --- | --- |
| Languages | `English, Spanish, Hindi, Kannada` | exact, no dropped chars |
| Target roles | `Python Backend Developer, AI Engineer (Remote)` | exact |
| Skills | `TypeScript, MongoDB, React` | exact |
| Project technologies | `React, tRPC, Postgres, MongoDB` | exact |
| Insert-in-middle / delete | mid-string edit | exact |

The saved profile round-tripped through `PUT /api/profile` → `GET /api/profile`
with the arrays intact (`targetRoles: ["Python Backend Developer","AI Engineer (Remote)"]`,
`languages: ["English","Spanish","Hindi","Kannada"]`, project
`technologies: ["React","tRPC","Postgres","MongoDB"]`).

---

## 4. P0 — Navigation finalised

`Job Radar · Workflow · Resume · Profile · Settings`. `Status` is gone from the
visible nav (the health endpoint is still live and internal). `Overview` was
renamed to `Workflow`. The active item is signalled three ways at once — a filled
surface, a brighter label, and `aria-current="page"` — so it is obvious in a
screenshot, in high-contrast mode, and to a screen reader. The row is a single
non-wrapping track that scrolls sideways on narrow screens instead of wrapping
raggedly. (`src/components/site-chrome.tsx`, new `src/components/nav-links.tsx`.)

---

## 5. P0 — Functionality preservation

Confirmed by the unchanged 548-test suite plus the live browser run: resume
upload (PDF/DOCX), parsing, profile persistence and editing, preferences,
worldwide/remote handling, the SerpApi Google Jobs integration, experience-level
filtering, freshness, dedup, relevance scoring, match explanations, apply URLs,
last-scan persistence, repeat searches, new-job detection, zero-result handling,
MongoDB persistence, and API contracts. Only two render tests were edited (the
workflow responsive layout and a caption size token) — both are presentation, not
behaviour.

---

## 6. P1 — Typography hierarchy

Hero 40–56px, page 30–40px, section 22–28px, card title 18–22px, primary body
15–17px, secondary 14–15px, metadata 13–14px, buttons 14–16px, workflow title
15–18px, workflow metadata 13–14px. Monospace is reserved for technical/status
metadata only (the status badge, references, footer credit).

---

## 7. P1 — Job results are the payoff

Results header shows the count and a plain-language scan summary plus stat chips
(`24 matching jobs`, `24 new`, `14 within 7d`, `0/24 with salary`, `10 with no
stated age`, `2/2 searches`). Each card reads **title → company → location/remote
→ freshness → match → why → Apply**:

```
Python Backend Developer (FastAPI/Django, Cloud)   Diverse Lynx   New York, USA
42 Match · Salary not listed · Age not stated · via Jobrapido · New
Matches your target role: Python Backend Developer · Matches 1 of your skills (MongoDB) · +1 more
[ Apply ↗ ]
```

The score is a circular badge labelled **Match** (a relevance score, never a
"% chance hired" claim). Reason chips cap at 3 with `+N more`. Hover is subtle
(border + surface lift).

---

## 8. P1 — The Workflow centrepiece

Six stages — **Resume Upload → Parse Profile → Review Profile → SerpApi → Process
→ Job Matches** — each with an icon, title, description/caption and a distinct
completion state. States are never colour-only: every node carries a visible
status word (`idle`/`running`/`done`/`failed`) plus a state dot. The layout is
horizontal on desktop (`lg:flex-row`) and vertical on mobile (`flex-col`), with
no horizontal overflow (verified: `scrollWidth 1011 ≤ innerWidth 1022`). Real
captions from the live run: `2/2 searches`, `39 raw · 0 duplicate`, `24 matches`.

---

## 9. P1 — First screen is state-adaptive

**New user:** hero *"Find roles that actually fit you."* + a WHAT/HOW/RESULT
summary + a 4-step strip (Upload → Extract → Search → Rank) + a strong CTA
*"Upload your resume →"*, and an honest empty state that keeps the
`Matches appear here once the pipeline runs.` line.

**Returning user:** progress is restored — all six workflow nodes come back
`completed`, the previous scan's 24 matches are re-rendered from
`GET /api/jobs/last`, and `Start Workflow` is enabled for a repeat search.

---

## 10. P1 — Profile Review workspace

Six clearly headed sections: **About you, What you're looking for, Experience,
Education, Projects, Certifications**. Labels sit above larger inputs; every
field is marked consistently `(required)` / `(optional)` (17 labels, 1 required,
11 optional, all but the nested checkbox paired via `htmlFor`/`id`). Structured
cards for experience/education/projects/certifications, and the list fields all
use the fixed `ListInput`.

---

## 11. P1 — Apply CTA contract

Every primary job CTA's **visible** text is exactly `Apply`, and it opens the
existing `job.applyUrl` in a new tab. Source is shown separately as
`via <publisher>` (e.g. `via LinkedIn`, `via Jobrapido`). The decorative arrow is
`aria-hidden`, so the accessible name stays clean (`Apply to <job title>`).

---

## 12. P2 — Loading / error / empty / success states

- **Contextual loading:** `Searching live jobs…` (captured live), with
  `Parsing your resume…` / `Filtering and ranking matches…` wired for the other
  stages.
- **Human-readable errors** that preserve the provider/invalid/no-results/
  processing/profile distinction. Verified live: a profile with no location
  produces a real `400` and the message *"Choose at least one location on your
  profile before running a search."* on all three discovery nodes — not a fake
  green tick.
- **Empty state:** *"Matches appear here once the pipeline runs."*
- **Zero-result** handling renders *"Google Jobs returned no results for this
  search."* (a successful scan that matched nothing is never reported as a
  provider failure).

---

## 13. P2 — Responsive behavior

Desktop shows the six workflow nodes horizontally; mobile stacks them
vertically. No horizontal page overflow at the tested viewport. The nav track and
the workflow row both scroll rather than wrap. All pages use a single
`max-w-5xl` column that reflows cleanly.

---

## 14. P2 — Accessibility (measured)

Lighthouse/axe on both key pages: **Accessibility 1.00, 0 failing audits**. Fixed
during the pass:

- **Contrast:** the disabled Start button and the muted workflow node text were
  too dim — raised to `zinc-400`, clearing 4.5:1.
- **Label in Name (WCAG 2.5.3):** workflow nodes carried an `aria-label` that
  reordered/reformatted the visible text (uppercase status, multi-line caption).
  Removed it, so each node's accessible name is now exactly its visible text.

Also present: a skip-link, `aria-current` on the active nav item, a single
`:focus-visible` ring, `prefers-reduced-motion` guards for both animations, and a
`color-scheme: dark` declaration.

---

## 15. P2 — Microinteractions & visual consistency

One entrance animation (`jr-rise`, 6px / 240ms) and one "wire signal" dot that
runs only while a stage is genuinely processing — both disabled under reduced
motion. Cards lift subtly on hover. Every surface uses the same token set
(`--surface`, `--surface-raised`, `--border`, `--accent` …), so no page drifts
from the palette.

---

## 16. P3 — Resume & Settings polish

`Resume`: a real drop zone (drag-and-drop + click), upload statuses, and a
`upload-modal` with Escape-to-close and body scroll-lock. `Settings`: an eyebrow
header, tokenised section cards, and live service status with word-labelled dots
(never colour alone). Health endpoint verified: `serpapi: pass ("API key
configured")`, `mongodb: pass ("connected to job_radar in 27ms")`.

---

## 17. P4 — First-visit tour

Intentionally deferred. It was explicitly optional and only to run after P0/P1,
conditional on stability. With no DOM test stack in the repo, a tour would ship
without automated coverage, so the safer call was to leave it out rather than
risk the demo. It can be added later behind a localStorage flag with no impact on
the verified surfaces.

---

## 18. Gates, live verification, limitations, files

**Gates (final state):** `npm test` 548/548 · `typecheck` clean · `lint` clean ·
`build` clean (routes: `/`, `/_not-found`, `/api/*` × 7, `/profile-review`,
`/resume`, `/settings`).

**Live end-to-end proof (real browser, real MongoDB, real SerpApi):** uploaded
the real DOCX → parsed → reviewed → `Start Workflow` → `Searching live jobs…` →
`2/2 searches, 39 raw · 0 duplicate, 24 matches` → 24 rendered cards with match
badges, reason chips, `via <source>`, and `Apply` links to real `applyUrl`s →
reloaded and confirmed last-scan restore. The health and 404 pages were also
checked live.

**Limitations (not hidden):**
- Screenshots could not be captured — this environment has no visible desktop
  window, so `browser.screenshot` refuses. All UI evidence above was read from the
  live DOM and the accessibility tree instead.
- The `con` entry in `git status` is a Windows reserved-device-name phantom (no
  file exists on disk) and is harmless.
- Everything is uncommitted; nothing was committed or pushed.

**Primary files touched this pass:** `src/app/globals.css`, `src/app/layout.tsx`,
`src/app/page.tsx`, `src/app/profile-review/page.tsx`, `src/app/resume/page.tsx`,
`src/app/settings/page.tsx`, `src/app/not-found.tsx`, `src/app/error.tsx`,
`src/app/global-error.tsx`, `src/components/site-chrome.tsx`,
`src/components/nav-links.tsx`, `src/components/list-input.tsx`,
`src/components/workflow.tsx`, `src/components/workflow-content.tsx`,
`src/components/workflow-node.tsx`, `src/components/workflow-graph.tsx`,
`src/components/workflow-connection.tsx`, `src/components/job-results.tsx`,
`src/components/resume-upload.tsx`, `src/components/upload-modal.tsx`,
`src/components/workflow-graph.test.ts`.
