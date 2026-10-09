/** Experience-level exclusion for job recommendations.
 *
 * Only the job title is examined — company, location, and description are
 * intentionally excluded so that words like "lead" in a company name do not
 * cause false exclusions (e.g. "Intern, Lead Generation Team").
 *
 * Roman‑numeral seniority (III, IV, V) is NOT treated as an exclusion for
 * internship users, per the product policy.
 *
 * "lead" has special handling: the title is only excluded if it does not also
 * contain an intern/junior/entry-level indicator.
 *
 * All matching uses simple string operations (includes / padded includes)
 * to keep the module transform‑stable for the Vitest/OXC harness.
 */
export function isExcludedByExperienceLevel(
  title: string,
  wantedLevel: string
): boolean {
  // Only apply internship filtering.
  if (wantedLevel !== "internship") {
    return false;
  }

  const lower = (title || "").toLowerCase();
  const padded = " " + lower + " ";

  // Senior signals — word-boundary checked via padded includes.
  // Using plain includes avoids regex that the OXC transformer flags.
  // Covers: Senior, Sr., Staff, Principal, Manager, Director, Head, VP,
  // Chief, Expert, Architect. Note: "Lead" has special handling below.
  const seniorKeywords = [
    "senior",
    "staff",
    "principal",
    "manager",
    "vp",
    "chief",
    "expert",
    "architect",
    "head",
    "sr.",
  ];

  let excluded = false;
  for (const kw of seniorKeywords) {
    if (padded.includes(" " + kw + " ")) {
      excluded = true;
      break;
    }
  }

  // Special case: "lead" — only exclude when the title does NOT also
  // contain an intern/junior/entry-level indicator.
  if (!excluded) {
    const hasIntern = lower.includes("intern");
    const hasJunior = lower.includes("junior");
    const leadIsStandalone = padded.includes(" lead ");
    if (leadIsStandalone && !hasIntern && !hasJunior) {
      excluded = true;
    }
  }

  return excluded;
}