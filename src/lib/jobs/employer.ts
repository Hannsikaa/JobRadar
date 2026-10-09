import { normalizeName } from "@/lib/jobs/text";

/**
 * Employer identity: deciding whether a domain, an ATS board, or a title
 * plausibly belongs to the company a listing names.
 *
 * The whole module exists because a URL is not an employer. `granite.wd1.myworkdayjobs.com`
 * is a Workday board, but it is *Granite Construction's* board, not Pinterest's,
 * even though it arrived attached to a Pinterest listing. A recognised ATS is
 * therefore not evidence of anything on its own: the tenant has to match the
 * advertised company.
 *
 * Two rules keep matching honest:
 *
 * 1. **A match needs a real token, at a real boundary.** `apple.com` matches
 *    "Apple"; `pineapple.com` and `applebees.com` do not, because the employer's
 *    name is not the whole brand label and the leftover text is not a known
 *    brand word (`careers`, `jobs`, `inc`, …). This is what stops a domain that
 *    merely *contains* an employer's name from being claimed as theirs.
 * 2. **Absence of a match is not a claim of fraud.** A failure to match means
 *    "unverified", never "this is a different company". Only a recognised ATS
 *    whose tenant clearly belongs to somebody else is called a third party.
 */

/** Corporate/legal words that carry no identity on their own. */
const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "srl",
  "bv",
  "nv",
  "pty",
  "corp",
  "corporation",
  "company",
  "co",
  "holdings",
  "holding",
  "group",
  "international",
  "intl",
]);

/** Connector words that should never be treated as identity. */
const STOPWORDS = new Set(["the", "and", "of", "for", "with", "from", "und", "et"]);

/**
 * Words that commonly trail or precede a brand inside a hostname.
 *
 * These are what makes `pinterestcareers.com` a match for "Pinterest" while
 * `pineapple.com` is not a match for "Apple": the leftover text after the brand
 * must be one of these, not arbitrary letters.
 */
const BRAND_SUFFIXES = [
  "careers",
  "career",
  "jobs",
  "job",
  "hiring",
  "hire",
  "apply",
  "talent",
  "talents",
  "recruiting",
  "recruitment",
  "recruit",
  "work",
  "works",
  "people",
  "team",
  "teams",
  "university",
  "campus",
  "global",
  "group",
  "inc",
  "corp",
  "corporation",
  "company",
  "companies",
  "international",
  "intl",
  "portal",
  "board",
  "boards",
  "hub",
  "hq",
  "tech",
  "labs",
  "life",
  "culture",
  "join",
  "about",
  "my",
];

const BRAND_PREFIXES = [
  "careers",
  "career",
  "jobs",
  "job",
  "apply",
  "hire",
  "hiring",
  "my",
  "join",
  "go",
  "about",
  "corporate",
  "get",
  "work",
  "team",
  "teams",
  "the",
  "we",
  "weare",
  "at",
  "talent",
  "global",
  "portal",
  "inside",
  "people",
];

function isBrandSuffix(remainder: string): boolean {
  if (remainder.length === 0) {
    return false;
  }

  return BRAND_SUFFIXES.some((suffix) => remainder === suffix || remainder.startsWith(suffix));
}

function isBrandPrefix(prefix: string): boolean {
  if (prefix.length === 0) {
    return false;
  }

  return BRAND_PREFIXES.some((entry) => prefix === entry || prefix.endsWith(entry));
}

/** Normalized identity words of an employer name, without legal/connector noise. */
export function employerTokens(company: string): string[] {
  const normalized = normalizeName(company);
  if (normalized.length === 0) {
    return [];
  }

  return normalized
    .split(" ")
    .filter(
      (word) => word.length > 0 && !STOPWORDS.has(word) && !LEGAL_SUFFIXES.has(word)
    );
}

/** The employer's identity words joined, used for hostname concatenations. */
export function employerSlug(company: string): string {
  return employerTokens(company).join("");
}

/** Identity words long enough to be meaningful on their own. */
export function distinctiveEmployerTokens(company: string): string[] {
  return employerTokens(company).filter((token) => token.length >= 4);
}

/**
 * Second-level parts of a multi-part public suffix, so the brand label can be
 * found without a full public-suffix list.
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "ac",
  "edu",
  "or",
  "ne",
  "go",
  "in",
  "web",
  "gen",
  "firm",
  "nom",
  "id",
]);

/**
 * The registrable brand label of a hostname: the label immediately before the
 * public suffix (`careers.pinterest.com` → `pinterest`, `acme.co.uk` → `acme`).
 *
 * Only this label is eligible to be called the employer's own domain. A label
 * anywhere else in the hostname is a subdomain and proves nothing —
 * `bob.blogspot.com` must not become "Bob".
 */
export function brandLabelOf(host: string): string | null {
  const parts = host.split(".").filter((part) => part.length > 0);
  if (parts.length < 2) {
    return null;
  }

  // Start just left of the trailing TLD, then step left past any second-level
  // public suffix (`co.uk`, `com.br`) so the brand label is what remains.
  let brandIndex = parts.length - 2;
  while (brandIndex > 0 && SECOND_LEVEL_SUFFIXES.has(parts[brandIndex])) {
    brandIndex -= 1;
  }

  const brand = parts[brandIndex];
  return brand !== undefined && brand.length > 0 ? brand : null;
}

/**
 * True when `host` plausibly belongs to `company`.
 *
 * Only the registrable brand label is eligible, matched as a whole label or with
 * a recognised brand word on the side (`pinterestcareers` for "Pinterest"). A
 * name that merely appears as a substring or as an unrelated subdomain does not
 * qualify. Deliberately strict: a false negative makes a link "unverified"
 * (safe), while a false positive would call a stranger's site the employer's own.
 */
export function employerMatchesHost(host: string, company: string): boolean {
  const slug = employerSlug(company);
  if (slug.length < 2) {
    return false;
  }

  const label = brandLabelOf(host);
  if (label === null) {
    return false;
  }

  if (matchesLabel(label, slug)) {
    return true;
  }

  for (const token of distinctiveEmployerTokens(company)) {
    if (matchesLabel(label, token)) {
      return true;
    }
  }

  return false;
}

function matchesLabel(label: string, needle: string): boolean {
  if (label === needle) {
    return true;
  }

  if (label.startsWith(needle) && isBrandSuffix(label.slice(needle.length))) {
    return true;
  }

  if (label.endsWith(needle) && isBrandPrefix(label.slice(0, label.length - needle.length))) {
    return true;
  }

  return false;
}

/**
 * True when an ATS board tenant plausibly belongs to `company`.
 *
 * A tenant is the company identifier an ATS puts in a subdomain
 * (`granite.wd1.myworkdayjobs.com`) or a path segment
 * (`jobs.lever.co/granite`). It is matched the same conservative way as a hostname.
 */
export function tenantMatchesEmployer(tenant: string, company: string): boolean {
  const normalized = tenant.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length < 3) {
    return false;
  }

  const slug = employerSlug(company);
  if (slug.length === 0) {
    return false;
  }

  if (normalized === slug || normalized.includes(slug)) {
    return true;
  }

  for (const token of distinctiveEmployerTokens(company)) {
    if (normalized === token || normalized.includes(token)) {
      return true;
    }
  }

  // The tenant may be an abbreviation of a longer company name
  // ("granite" for "Granite Construction"). Only trusted when it is long enough
  // to not be a coincidental substring.
  if (normalized.length >= 5 && slug.includes(normalized)) {
    return true;
  }

  return false;
}

/**
 * Coarse role families, most specific first. A title maps to the first family
 * one of its identity words belongs to.
 *
 * This exists so title comparison can tell "software" from "civil/construction"
 * instead of treating a shared generic word like "engineer" as agreement.
 */
const ROLE_FAMILIES: readonly (readonly [string, readonly string[]])[] = [
  [
    "software",
    [
      "software",
      "swe",
      "developer",
      "frontend",
      "front",
      "backend",
      "back",
      "fullstack",
      "stack",
      "web",
      "mobile",
      "ios",
      "android",
      "devops",
      "sre",
      "qa",
      "tester",
      "programmer",
      "programming",
      "cloud",
      "platform",
      "infrastructure",
    ],
  ],
  ["data", ["data", "analytics", "analyst", "scientist", "ml", "machine", "learning", "ai"]],
  ["design", ["design", "designer", "ux", "ui", "graphic", "creative"]],
  [
    "construction",
    ["civil", "construction", "structural", "site", "surveying", "surveyor", "architectural"],
  ],
  ["mechanical", ["mechanical", "mechatronics", "manufacturing", "industrial", "electrical"]],
  ["healthcare", ["nurse", "medical", "clinical", "health", "physician", "pharma"]],
  ["finance", ["finance", "financial", "accounting", "accountant", "audit", "tax", "investment"]],
  ["legal", ["legal", "lawyer", "counsel", "paralegal", "compliance"]],
  ["marketing", ["marketing", "growth", "brand", "content", "seo", "communications"]],
  ["sales", ["sales", "account", "business", "bdr", "sdr"]],
  ["hr", ["hr", "human", "recruiter", "recruiting", "talent", "people"]],
  ["support", ["support", "customer", "success", "service"]],
  ["operations", ["operations", "ops", "logistics", "supply", "procurement"]],
  ["management", ["manager", "management", "director", "lead", "head", "leadership"]],
];

/** The coarse family a title belongs to, or `null` when it names none. */
export function roleFamily(title: string): string | null {
  const tokens = normalizeName(title).split(" ");
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0].length === 0)) {
    return null;
  }

  for (const [family, keywords] of ROLE_FAMILIES) {
    if (keywords.some((keyword) => tokens.includes(keyword))) {
      return family;
    }
  }

  return null;
}

/**
 * Whether two job titles describe a compatible role.
 *
 * It compares coarse role families first, which rejects clear contradictions
 * ("Software Engineer Intern" vs "Civil Engineer") while allowing the
 * abbreviations a real posting uses ("SWE Intern" vs "Software Engineer
 * Intern"). When either title has no recognisable family it falls back to shared
 * identity words, and when one is empty it abstains (`true`). Title text alone is
 * weak evidence, so a `false` is a hint, not a verdict.
 */
export function titlesAreConsistent(a: string, b: string): boolean {
  const familyA = roleFamily(a);
  const familyB = roleFamily(b);
  if (familyA !== null && familyB !== null) {
    return familyA === familyB;
  }

  const aTokens = normalizeName(a)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  const bTokens = new Set(normalizeName(b).split(" "));

  if (aTokens.length === 0 || bTokens.size === 0) {
    return true;
  }

  return aTokens.some((token) => bTokens.has(token));
}
