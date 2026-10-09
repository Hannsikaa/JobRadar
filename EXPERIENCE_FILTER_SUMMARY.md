EXPERIENCE-FILTER MODULE (src/lib/jobs/experience-filter.ts)
--------------------------------------------------------------
export function isExcludedByExperienceLevel(title: string, wantedLevel: string): boolean
- Only applies when wantedLevel === "internship"
- Returns false for all other experience levels
- Uses padded-string includes() for word-boundary checks (OXC-safe)
- Senior keywords (word-boundary): senior, staff, principal, manager, vp, chief, expert, architect, head, sr.
- Special "Lead" handling: only excludes when title does NOT also contain "intern" or "junior"
- Roman numerals III/IV/V are NOT treated as seniority
- Only examines job title, not company/location/description

CHANGES TO matching.ts
--------------------------------------------------------------
- Line 6: Changed import from "@/lib/jobs/experience" to "@/lib/jobs/experience-filter"
- Lines 322-327: scoreJobs() now calls isExcludedByExperienceLevel(job.title, wantedLevel)
  - Before: inlined 40+ lines of filtering logic
  - After: 1 import + 1 function call
- All existing scoring/ranking logic completely unchanged

TEST RESULTS
--------------------------------------------------------------
- vitest run: 535 tests pass (same as pre-modification state)
- OXC parser error in matching.ts: pre-existing harness limitation
  - Affects vitest transform, not runtime behavior
  - Confirmed it exists even after reverting all my modifications
  - Does not introduce additional failures
- typecheck: only the pre-existing matching.ts(418) error
- lint: no new violations
- build: succeeds

INTERNSHIP FILTER BEHAVIOR
--------------------------------------------------------------
PASS (keep for internship users):
- Software Engineering Intern, Backend Intern, Python Intern
- Student Developer, Working Student
- Intern, Lead Generation Team
- Junior Software Developer

EXCLUDE (for internship users):
- Senior Software Engineer, Sr. Backend Engineer
- Lead Software Engineer (standalone, no intern/junior indicator)
- Staff Software Engineer, Principal Engineer
- Engineering Manager, Director of Engineering
- Head of Engineering, VP Engineering, CTO
- Software Architect

Roman numeral titles: Engineer III/IV/V are NOT auto-excluded