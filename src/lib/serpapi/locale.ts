/**
 * Location → Google Jobs locale (gl / hl) resolution.
 *
 * SerpApi's google_jobs engine returns zero results for many non-US queries
 * when gl=us hl=en (e.g. "Berlin, Germany" only returns results with
 * gl=de hl=de). Resolution is purely deterministic: we map the country
 * segment of the location string (or a well-known city) to the gl/hl pair
 * that matches Google's own default for that country, and fall back to
 * gl=us hl=en when we cannot recognize it. No network calls, no guessing
 * beyond the table below.
 */

export type SearchLocale = {
  /** ISO 3166-1 alpha-2 country code used as SerpApi's `gl`. */
  gl: string;
  /** Google interface language code used as SerpApi's `hl`. */
  hl: string;
};

export const DEFAULT_SEARCH_LOCALE: SearchLocale = { gl: "us", hl: "en" };

/**
 * Country name (lowercase) → locale. The hl value is Google's own default
 * interface language for that country's domain, so the pair always matches
 * what a local user would see. Includes common aliases (uk/great britain,
 * germany/deutschland, usa/united states of america, korea, russia, etc.).
 */
const COUNTRY_LOCALES: Record<string, SearchLocale> = {
  // English-default countries
  australia: { gl: "au", hl: "en" },
  canada: { gl: "ca", hl: "en" },
  "new zealand": { gl: "nz", hl: "en" },
  india: { gl: "in", hl: "en" },
  ireland: { gl: "ie", hl: "en" },
  israel: { gl: "il", hl: "en" },
  kenya: { gl: "ke", hl: "en" },
  malaysia: { gl: "my", hl: "en" },
  nigeria: { gl: "ng", hl: "en" },
  "south africa": { gl: "za", hl: "en" },
  singapore: { gl: "sg", hl: "en" },
  philippines: { gl: "ph", hl: "en" },
  pakistan: { gl: "pk", hl: "en" },
  "sri lanka": { gl: "lk", hl: "en" },
  bangladesh: { gl: "bd", hl: "en" },
  "hong kong": { gl: "hk", hl: "en" },
  "united arab emirates": { gl: "ae", hl: "en" },
  uae: { gl: "ae", hl: "en" },
  "saudi arabia": { gl: "sa", hl: "en" },
  qatar: { gl: "qa", hl: "en" },
  jordan: { gl: "jo", hl: "en" },
  "puerto rico": { gl: "pr", hl: "en" },
  "costa rica": { gl: "cr", hl: "en" },
  "dominican republic": { gl: "do", hl: "en" },
  panama: { gl: "pa", hl: "en" },
  "newfoundland and labrador": { gl: "ca", hl: "en" },

  // Non-English defaults (Google's own default hl for that domain)
  austria: { gl: "at", hl: "de" },
  belgium: { gl: "be", hl: "nl" },
  germany: { gl: "de", hl: "de" },
  deutschland: { gl: "de", hl: "de" },
  spain: { gl: "es", hl: "es" },
  españa: { gl: "es", hl: "es" },
  mexico: { gl: "mx", hl: "es" },
  argentina: { gl: "ar", hl: "es" },
  colombia: { gl: "co", hl: "es" },
  chile: { gl: "cl", hl: "es" },
  peru: { gl: "pe", hl: "es" },
  venezuela: { gl: "ve", hl: "es" },
  bolivia: { gl: "bo", hl: "es" },
  "dominican rep": { gl: "do", hl: "es" },
  ecuador: { gl: "ec", hl: "es" },
  guatemala: { gl: "gt", hl: "es" },
  "el salvador": { gl: "sv", hl: "es" },
  honduras: { gl: "hn", hl: "es" },
  nicaragua: { gl: "ni", hl: "es" },
  uruguay: { gl: "uy", hl: "es" },
  paraguay: { gl: "py", hl: "es" },
  france: { gl: "fr", hl: "fr" },
  italia: { gl: "it", hl: "it" },
  italy: { gl: "it", hl: "it" },
  netherlands: { gl: "nl", hl: "nl" },
  holland: { gl: "nl", hl: "nl" },
  portugal: { gl: "pt", hl: "pt" },
  brazil: { gl: "br", hl: "pt" },
  poland: { gl: "pl", hl: "pl" },
  polska: { gl: "pl", hl: "pl" },
  russia: { gl: "ru", hl: "ru" },
  "russian federation": { gl: "ru", hl: "ru" },
  turkey: { gl: "tr", hl: "tr" },
  türkiye: { gl: "tr", hl: "tr" },
  japan: { gl: "jp", hl: "ja" },
  "south korea": { gl: "kr", hl: "ko" },
  korea: { gl: "kr", hl: "ko" },
  "republic of korea": { gl: "kr", hl: "ko" },
  china: { gl: "cn", hl: "zh-CN" },
  taiwan: { gl: "tw", hl: "zh-TW" },
  "hong kong sar": { gl: "hk", hl: "zh-TW" },
  thailand: { gl: "th", hl: "th" },
  vietnam: { gl: "vn", hl: "vi" },
  indonesia: { gl: "id", hl: "id" },
  ukraine: { gl: "ua", hl: "uk" },
  "czech republic": { gl: "cz", hl: "cs" },
  czechia: { gl: "cz", hl: "cs" },
  denmark: { gl: "dk", hl: "da" },
  finland: { gl: "fi", hl: "fi" },
  norway: { gl: "no", hl: "no" },
  sweden: { gl: "se", hl: "sv" },
  greece: { gl: "gr", hl: "el" },
  hungary: { gl: "hu", hl: "hu" },
  romania: { gl: "ro", hl: "ro" },
  bulgaria: { gl: "bg", hl: "bg" },
  croatia: { gl: "hr", hl: "hr" },
  serbia: { gl: "rs", hl: "sr" },
  slovakia: { gl: "sk", hl: "sk" },
  slovenia: { gl: "si", hl: "sl" },
  lithuania: { gl: "lt", hl: "lt" },
  latvia: { gl: "lv", hl: "lv" },
  estonia: { gl: "ee", hl: "et" },
  iceland: { gl: "is", hl: "is" },

  // United Kingdom resolves to the uk domain (English interface)
  uk: { gl: "uk", hl: "en" },
  "u.k.": { gl: "uk", hl: "en" },
  "united kingdom": { gl: "uk", hl: "en" },
  "great britain": { gl: "uk", hl: "en" },
  britain: { gl: "uk", hl: "en" },
  england: { gl: "uk", hl: "en" },
  scotland: { gl: "uk", hl: "en" },
  wales: { gl: "uk", hl: "en" },

  // United States — recognized so "Georgia" (country) never maps, but
  // US city/state inputs stay at the default gl=us hl=en.
  "united states": DEFAULT_SEARCH_LOCALE,
  "united states of america": DEFAULT_SEARCH_LOCALE,
  usa: DEFAULT_SEARCH_LOCALE,
  america: DEFAULT_SEARCH_LOCALE,
  "us": DEFAULT_SEARCH_LOCALE,
  "u.s.": DEFAULT_SEARCH_LOCALE,
};

/**
 * Well-known cities → locale, for bare-city inputs with no country segment
 * ("Berlin" → de). Keyed lowercase. Deliberately narrow: only cities whose
 * country default is unambiguous. US cities are omitted because the default
 * (gl=us hl=en) already covers them.
 */
const CITY_LOCALES: Record<string, SearchLocale> = {
  berlin: { gl: "de", hl: "de" },
  munich: { gl: "de", hl: "de" },
  münchen: { gl: "de", hl: "de" },
  hamburg: { gl: "de", hl: "de" },
  cologne: { gl: "de", hl: "de" },
  köln: { gl: "de", hl: "de" },
  frankfurt: { gl: "de", hl: "de" },
  stuttgart: { gl: "de", hl: "de" },
  düsseldorf: { gl: "de", hl: "de" },
  madrid: { gl: "es", hl: "es" },
  barcelona: { gl: "es", hl: "es" },
  paris: { gl: "fr", hl: "fr" },
  lyon: { gl: "fr", hl: "fr" },
  amsterdam: { gl: "nl", hl: "nl" },
  rotterdam: { gl: "nl", hl: "nl" },
  milan: { gl: "it", hl: "it" },
  milano: { gl: "it", hl: "it" },
  rome: { gl: "it", hl: "it" },
  roma: { gl: "it", hl: "it" },
  lisbon: { gl: "pt", hl: "pt" },
  lisboa: { gl: "pt", hl: "pt" },
  london: { gl: "uk", hl: "en" },
  manchester: { gl: "uk", hl: "en" },
  "birmingham uk": { gl: "uk", hl: "en" },
  edinburgh: { gl: "uk", hl: "en" },
  dublin: { gl: "ie", hl: "en" },
  toronto: { gl: "ca", hl: "en" },
  vancouver: { gl: "ca", hl: "en" },
  montreal: { gl: "ca", hl: "fr" },
  sydney: { gl: "au", hl: "en" },
  melbourne: { gl: "au", hl: "en" },
  tokyo: { gl: "jp", hl: "ja" },
  osaka: { gl: "jp", hl: "ja" },
  seoul: { gl: "kr", hl: "ko" },
  singapore: { gl: "sg", hl: "en" },
  bangkok: { gl: "th", hl: "th" },
  "hong kong": { gl: "hk", hl: "en" },
  shanghai: { gl: "cn", hl: "zh-CN" },
  "beijing": { gl: "cn", hl: "zh-CN" },
  dubai: { gl: "ae", hl: "en" },
  "abu dhabi": { gl: "ae", hl: "en" },
  "tel aviv": { gl: "il", hl: "en" },
  "new delhi": { gl: "in", hl: "en" },
  delhi: { gl: "in", hl: "en" },
  bangalore: { gl: "in", hl: "en" },
  bengaluru: { gl: "in", hl: "en" },
  hyderabad: { gl: "in", hl: "en" },
  mumbai: { gl: "in", hl: "en" },
  chennai: { gl: "in", hl: "en" },
  pune: { gl: "in", hl: "en" },
  kolkata: { gl: "in", hl: "en" },
  lahore: { gl: "pk", hl: "en" },
  karachi: { gl: "pk", hl: "en" },
  "sao paulo": { gl: "br", hl: "pt" },
  "rio de janeiro": { gl: "br", hl: "pt" },
  "mexico city": { gl: "mx", hl: "es" },
  warsaw: { gl: "pl", hl: "pl" },
  kraków: { gl: "pl", hl: "pl" },
  prague: { gl: "cz", hl: "cs" },
  stockholm: { gl: "se", hl: "sv" },
  copenhagen: { gl: "dk", hl: "da" },
  oslo: { gl: "no", hl: "no" },
  helsinki: { gl: "fi", hl: "fi" },
  zurich: { gl: "ch", hl: "de" },
  zürich: { gl: "ch", hl: "de" },
  geneva: { gl: "ch", hl: "fr" },
  vienna: { gl: "at", hl: "de" },
  brussels: { gl: "be", hl: "nl" },
  istanbul: { gl: "tr", hl: "tr" },
  ankara: { gl: "tr", hl: "tr" },
  athens: { gl: "gr", hl: "el" },
  budapest: { gl: "hu", hl: "hu" },
  bucharest: { gl: "ro", hl: "ro" },
  kyiv: { gl: "ua", hl: "uk" },
  moscow: { gl: "ru", hl: "ru" },
};

/** Strip diacritics and lowercase for table lookups. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Tables with folded keys, so "münchen" and "Munchen" hit the same entry as
 * the diacritic-stripped form produced by `fold()` on the input.
 */
const COUNTRIES_FOLDED: Record<string, SearchLocale> = Object.fromEntries(
  Object.entries(COUNTRY_LOCALES).map(([key, locale]) => [fold(key), locale])
);
const CITIES_FOLDED: Record<string, SearchLocale> = Object.fromEntries(
  Object.entries(CITY_LOCALES).map(([key, locale]) => [fold(key), locale])
);

/**
 * Resolve the gl/hl pair for a free-form location string.
 *
 * Order: exact location match → last comma segment as country → any comma
 * segment as country → whole string as city → default (us/en).
 */
export function resolveSearchLocale(location: string): SearchLocale {
  const raw = location.trim();
  if (!raw) return DEFAULT_SEARCH_LOCALE;

  const folded = fold(raw);

  // Exact match against country names (handles "Berlin, Germany" only after
  // segment checks, but also handles inputs that are exactly a country).
  const exactCountry = COUNTRIES_FOLDED[folded];
  if (exactCountry) return exactCountry;

  const segments = raw.split(",").map((segment) => segment.trim());
  if (segments.length > 1) {
    // Last segment is the country in "City, Country" form.
    const last = fold(segments[segments.length - 1] ?? "");
    const lastCountry = COUNTRIES_FOLDED[last];
    if (lastCountry) return lastCountry;

    // Also try full country names that contain commas themselves,
    // e.g. "London, United Kingdom" already covered; "X, Trinidad and Tobago"
    // style names would fail the single-segment lookup, so try the join.
    const joined = fold(segments.slice(1).join(","));
    const joinedCountry = COUNTRIES_FOLDED[joined];
    if (joinedCountry) return joinedCountry;

    // First segment as country (rare reversed form "Germany, Berlin").
    const first = fold(segments[0] ?? "");
    const firstCountry = COUNTRIES_FOLDED[first];
    if (firstCountry) return firstCountry;
  }

  // Bare city (no country segment) — well-known cities only.
  const city = CITIES_FOLDED[folded];
  if (city) return city;

  return DEFAULT_SEARCH_LOCALE;
}

/**
 * Location phrases that ask for a global or remote search rather than a place.
 * SerpApi's google_jobs engine rejects these with HTTP 400
 * ("Unsupported `worldwide` location"), so they must not be forwarded.
 */
const NON_GEOGRAPHIC_LOCATION_PATTERN =
  /^(?:world\s?wide|global|anywhere|any\s?place|remote(?:\s+.*)?|wfh|work\s+from\s+home|work\s+from\s+anywhere|earth)$/i;

/**
 * Converts a free-text location into a value SerpApi's google_jobs engine
 * accepts, or `undefined` to search without a location scope.
 *
 * A global/remote phrase is dropped instead of being passed through: omitting
 * `location` returns worldwide results, whereas sending "worldwide" or
 * "Remote in Europe" fails the whole request. Real places are returned
 * unchanged, so the existing locale handling still applies.
 */
export function toProviderLocation(location: string | undefined): string | undefined {
  const trimmed = location?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (NON_GEOGRAPHIC_LOCATION_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}
