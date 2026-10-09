import type { NormalizedSalary } from "@/lib/jobs/types";
import { normalizeWhitespace } from "@/lib/jobs/text";

/**
 * Reading a salary out of a printed string.
 *
 * Google Jobs prints salary as free text: "$25–$30 an hour", "₹15L - ₹20L per
 * year", "From £45,000". The raw string is always kept and always shown, because
 * the printed form is the one number the user can check against the listing.
 *
 * The parsed numbers exist only so a minimum can be compared. They are extracted
 * conservatively: if the currency or the period cannot be read, they are left
 * absent rather than guessed, and a job with no comparable salary is *kept* and
 * labelled unavailable instead of being rejected.
 */

/** Periods Google Jobs labels, mapped to the units this app reports. */
const PERIOD_PATTERNS: { pattern: RegExp; period: NormalizedSalary["period"] }[] = [
  { pattern: /\bper\s+year\b|\byearly\b|\bannually\b|\/\s*year\b|\byr\b/i, period: "year" },
  { pattern: /\bper\s+month\b|\bmonthly\b|\/\s*month\b|\bmo\b/i, period: "month" },
  { pattern: /\bper\s+week\b|\bweekly\b|\/\s*week\b|\bwk\b/i, period: "week" },
  { pattern: /\bper\s+day\b|\bdaily\b|\/\s*day\b/i, period: "day" },
  { pattern: /\bper\s+hour\b|\bhourly\b|\/\s*h(?:r|our)?\b|\ban\s+hour\b|\bapx\b|\bhr\b/i, period: "hour" },
];

/**
 * Currency symbols and codes seen on Google Jobs.
 *
 * Symbols map to a code so a symbol and its code compare equal. A bare number
 * with no symbol or code gets no currency: an amount without a currency cannot be
 * compared against a user's `salaryCurrency`, and guessing one would produce a
 * confident wrong answer.
 */
const CURRENCY_SYMBOLS: { symbol: string; code: string }[] = [
  { symbol: "₹", code: "INR" },
  { symbol: "$", code: "USD" },
  { symbol: "€", code: "EUR" },
  { symbol: "£", code: "GBP" },
  { symbol: "¥", code: "JPY" },
  { symbol: "A$", code: "AUD" },
  { symbol: "C$", code: "CAD" },
  { symbol: "S$", code: "SGD" },
  { symbol: "R$", code: "BRL" },
  { symbol: "HK$", code: "HKD" },
  { symbol: "AED", code: "AED" },
];

const CURRENCY_CODES = [
  "INR", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "SGD", "BRL", "HKD", "AED", "CHF", "ZAR", "SEK", "PLN", "NZD",
];

/** Indian and international short-scale suffixes as they appear in postings. */
const SCALE_MULTIPLIERS: { pattern: RegExp; multiplier: number }[] = [
  { pattern: /(?:lakhs?|lacs?)\b/i, multiplier: 100_000 },
  { pattern: /\bcrores?\b/i, multiplier: 10_000_000 },
  { pattern: /\bmillion\b|\bm\b/i, multiplier: 1_000_000 },
  { pattern: /\bk\b/i, multiplier: 1_000 },
];

/**
 * Parses a printed salary string.
 *
 * Returns `null` when there is no text to parse — never a zero salary, which
 * would read as "this pays nothing" and is a different, and false, claim.
 */
export function parseSalary(raw: string | undefined | null): NormalizedSalary | null {
  if (typeof raw !== "string") {
    return null;
  }

  const text = normalizeWhitespace(raw);
  if (text.length === 0) {
    return null;
  }

  const salary: NormalizedSalary = { text };

  const currency = readCurrency(text);
  if (currency !== null) {
    salary.currency = currency;
  }

  const period = readPeriod(text);
  if (period !== undefined) {
    salary.period = period;
  }

  const amounts = readAmounts(text);
  if (amounts.length > 0) {
    const [min, max] = amounts.length === 1 ? [amounts[0], undefined] : [Math.min(...amounts), Math.max(...amounts)];
    salary.min = min;
    salary.max = max;
  }

  // Nothing usable beyond the printed text: still return it, so the card can show
  // "$25–$30 an hour" even though no comparable number could be extracted.
  return salary;
}

/**
 * A salary floor to compare listings against.
 *
 * The period matters as much as the amount. "$30" and "$30,000" share a currency
 * and differ by three orders of magnitude, so a comparison that ignored the
 * period could reject a well-paid job for being an hourly rate. The profile's
 * own minimum has no period field, so callers state which period they mean and
 * the default is a year — the standard reading of "minimum salary".
 */
export type SalaryFloor = {
  amount: number;
  currency: string;
  period: NonNullable<NormalizedSalary["period"]>;
};

/** The period a user's `minimumSalary` is assumed to mean. */
export const DEFAULT_FLOOR_PERIOD: SalaryFloor["period"] = "year";

/**
 * Whether this salary can be compared against the floor.
 *
 * Requires a minimum value on the listing, plus a currency and a period, plus a
 * floor whose currency and period match. Two of three cannot decide a
 * comparison, and neither can a currency or period that differs.
 */
export function isSalaryComparable(
  salary: NormalizedSalary | undefined,
  minimum: SalaryFloor | undefined
): boolean {
  if (salary === undefined || minimum === undefined) {
    return false;
  }

  if (salary.min === undefined || salary.currency === undefined || salary.period === undefined) {
    return false;
  }

  return salary.currency === minimum.currency && salary.period === minimum.period;
}

/**
 * Whether a comparable salary meets the floor.
 *
 * Compares the *top* of a range against the minimum, because a range whose top is
 * below the floor cannot contain an acceptable offer. Only like periods and like
 * currencies are compared: this app does not convert currency, and does not
 * pretend an hourly rate is comparable to an annual floor.
 *
 * Returns `null` when the comparison cannot be made — that is "unknown", which is
 * not the same as "no". An incomparable salary never rejects a job.
 */
export function salaryMeetsMinimum(
  salary: NormalizedSalary | undefined,
  minimum: SalaryFloor | undefined
): boolean | null {
  if (!isSalaryComparable(salary, minimum) || salary === undefined || minimum === undefined) {
    return null;
  }

  const best = salary.max ?? salary.min;
  if (best === undefined) {
    return null;
  }

  return best >= minimum.amount;
}

/**
 * Normalizes a period to an equivalent annual figure for *display only*.
 *
 * Returns `null` unless the period and currency are both known. Callers must not
 * use this for filtering: it is a rough annualization shown next to an hourly or
 * monthly figure so the reader has context, and using it to reject a job would
 * be a precision the source data does not support.
 */
export function annualize(salary: NormalizedSalary): number | null {
  const base = salary.max ?? salary.min;
  if (base === undefined || salary.period === undefined) {
    return null;
  }

  const perYear: Record<NonNullable<NormalizedSalary["period"]>, number> = {
    hour: 2080,
    day: 260,
    week: 52,
    month: 12,
    year: 1,
  };

  return Math.round(base * perYear[salary.period]);
}

/** Reads a currency symbol or three-letter code from the text. */
function readCurrency(text: string): string | null {
  for (const { symbol, code } of CURRENCY_SYMBOLS) {
    if (text.includes(symbol)) {
      return code;
    }
  }

  const upper = text.toUpperCase();
  const code = CURRENCY_CODES.find((candidate) =>
    new RegExp(`(^|[^A-Z])${candidate}([^A-Z]|$)`).test(upper)
  );

  return code ?? null;
}

/** Reads the pay period. Returns `undefined` rather than assuming a default. */
function readPeriod(text: string): NormalizedSalary["period"] | undefined {
  for (const { pattern, period } of PERIOD_PATTERNS) {
    if (pattern.test(text)) {
      return period;
    }
  }

  return undefined;
}

/**
 * Extracts every monetary amount in the text, applying any scale suffix.
 *
 * Handles "15L", "1.2L", "₹15,00,000", "45,000", "$25.50". Indian digit grouping
 * ("15,00,000") is a real formatting SerpApi passes through, so all commas are
 * treated as grouping separators rather than as decimals — the decimal point in
 * these strings is always a `.`.
 */
function readAmounts(text: string): number[] {
  // Drop a leading currency symbol/code, keeping the digits that follow.
  const amounts: number[] = [];
  const pattern = /(\d[\d,.]*)\s*(lakhs?|lacs?|crores?|million|m|k\b)?/gi;

  for (const match of text.matchAll(pattern)) {
    const digits = match[1].replace(/,/g, "");
    const value = Number.parseFloat(digits);

    if (!Number.isFinite(value)) {
      continue;
    }

    const suffix = match[2];
    if (suffix === undefined) {
      amounts.push(value);
      continue;
    }

    const scale = SCALE_MULTIPLIERS.find((entry) => entry.pattern.test(suffix));
    if (scale !== undefined) {
      amounts.push(value * scale.multiplier);
    } else {
      amounts.push(value);
    }
  }

  return amounts;
}