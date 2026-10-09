import { z } from "zod";

/**
 * Environment configuration.
 *
 * Two separate schemas are intentional:
 * - `clientSchema` only contains `NEXT_PUBLIC_*` values, which Next.js inlines
 *   into the browser bundle at build time.
 * - `serverSchema` contains secrets. It must never be imported from a Client
 *   Component; `getServerEnv()` throws if it is ever evaluated in the browser.
 *
 * Optional variables treat an empty or whitespace-only string as "unset" so a
 * blank value in a `.env` file does not fail validation.
 */

const optionalString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const MONGODB_URI_PATTERN = /^mongodb(\+srv)?:\/\/.+/;
const DB_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  MONGODB_URI: optionalString.refine(
    (value) => value === undefined || MONGODB_URI_PATTERN.test(value),
    {
      message:
        "MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string",
    },
  ),
  MONGODB_DB_NAME: z
    .string()
    .trim()
    .min(1)
    .refine((value) => DB_NAME_PATTERN.test(value), {
      message:
        "MONGODB_DB_NAME may only contain letters, digits, underscores, and hyphens",
    })
    .default("job_radar"),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  SERPAPI_API_KEY: optionalString,
  SERPAPI_BASE_URL: z
    .string()
    .trim()
    .min(1)
    .default("https://serpapi.com"),
  /**
   * How many distinct employer+role+location lookups one scan may spend on
   * official-careers discovery. `0` disables the stage entirely.
   *
   * Each uncached lookup is one additional SerpApi request. The default of 3
   * keeps a scan within a few extra calls; the hard ceiling here means no
   * configuration can turn a single scan into an unbounded crawl.
   */
  OFFICIAL_DISCOVERY_MAX_TARGETS: z.coerce.number().int().min(0).max(25).default(3),
  /** How many discovery lookups run at once. Bounded to stay polite to SerpApi. */
  OFFICIAL_DISCOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** How long a positive (verified) destination stays cached, in days. */
  OFFICIAL_DISCOVERY_CACHE_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** How long a negative/neutral discovery outcome stays cached, in hours. */
  OFFICIAL_DISCOVERY_NEGATIVE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /**
   * How many distinct employer ATS boards one scan may query directly.
   *
   * These are public, unauthenticated board endpoints, so unlike the metered
   * SerpApi lookups this stage is cheap. `0` disables direct-source discovery
   * entirely; the ceiling keeps one scan from fanning out past a handful of
   * boards.
   */
  DIRECT_SOURCE_MAX_TARGETS: z.coerce.number().int().min(0).max(25).default(5),
  /** How many employer boards are fetched at once. */
  DIRECT_SOURCE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
  /** Maximum matched postings taken from any one board. */
  DIRECT_SOURCE_MAX_POSTINGS_PER_BOARD: z.coerce.number().int().min(0).max(200).default(25),
  /** Maximum matched postings added to one scan across all boards. */
  DIRECT_SOURCE_MAX_TOTAL_POSTINGS: z.coerce.number().int().min(0).max(500).default(60),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().trim().min(1).default("Job Radar"),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join(".") : "environment";
      return `  - ${key}: ${issue.message}`;
    })
    .join("\n");
}

let cachedServerEnv: ServerEnv | undefined;
let cachedClientEnv: ClientEnv | undefined;

/**
 * Test-only hook: drops the memoized parse results so a test can change
 * `process.env` and re-read configuration.
 */
export function __resetEnvCache(): void {
  cachedServerEnv = undefined;
  cachedClientEnv = undefined;
}

export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error(
      "getServerEnv() was called in the browser. Server environment variables are not exposed to client code.",
    );
  }

  if (cachedServerEnv) {
    return cachedServerEnv;
  }

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${formatIssues(parsed.error)}`,
    );
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

export function getClientEnv(): ClientEnv {
  if (cachedClientEnv) {
    return cachedClientEnv;
  }

  const parsed = clientSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid client environment configuration:\n${formatIssues(parsed.error)}`,
    );
  }

  cachedClientEnv = parsed.data;
  return cachedClientEnv;
}

/** True when a MongoDB connection string is available. Never throws. */
export function isDatabaseConfigured(): boolean {
  try {
    return getServerEnv().MONGODB_URI !== undefined;
  } catch {
    return false;
  }
}

/** True when a SerpApi key is available. Never throws. */
export function isSerpApiConfigured(): boolean {
  try {
    return getServerEnv().SERPAPI_API_KEY !== undefined;
  } catch {
    return false;
  }
}