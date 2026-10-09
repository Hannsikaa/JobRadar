import { getServerEnv } from "@/lib/env";
import { checkDatabaseHealth, type DatabaseHealth } from "@/lib/mongodb/health";

/**
 * Aggregated service health.
 *
 * Semantics used by `/api/health`:
 * - `ok`       every configured dependency is reachable.
 * - `degraded` an optional dependency is not configured yet. The app is usable.
 * - `error`    a configured dependency is unreachable, or configuration itself
 *              is invalid. The app is running but not functional.
 *
 * The reporter never throws: a health check that crashes is not a health check.
 */

export type CheckStatus = "pass" | "skip" | "fail";

export type HealthCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
};

export type HealthReport = {
  status: "ok" | "degraded" | "error";
  timestamp: string;
  checks: HealthCheck[];
};

function databaseCheck(health: DatabaseHealth): HealthCheck {
  if (!health.configured) {
    return {
      name: "mongodb",
      status: "skip",
      detail: health.error ?? "not configured",
    };
  }

  if (!health.reachable) {
    return {
      name: "mongodb",
      status: "fail",
      detail: health.error ?? "unreachable",
    };
  }

  const latency =
    health.latencyMs === null ? "" : ` in ${health.latencyMs}ms`;
  return {
    name: "mongodb",
    status: "pass",
    detail: `connected to ${health.database ?? "database"}${latency}`,
  };
}

function serpApiCheck(apiKey: string | undefined): HealthCheck {
  if (!apiKey) {
    return {
      name: "serpapi",
      status: "skip",
      detail: "SERPAPI_API_KEY is not configured",
    };
  }

  // The key is intentionally never echoed back, only its presence.
  return { name: "serpapi", status: "pass", detail: "API key configured" };
}

function rollUp(checks: HealthCheck[]): HealthReport["status"] {
  if (checks.some((check) => check.status === "fail")) {
    return "error";
  }
  if (checks.some((check) => check.status === "skip")) {
    return "degraded";
  }
  return "ok";
}

export async function getHealthReport(): Promise<HealthReport> {
  const timestamp = new Date().toISOString();

  let apiKey: string | undefined;
  try {
    ({ SERPAPI_API_KEY: apiKey } = getServerEnv());
  } catch (error) {
    return {
      status: "error",
      timestamp,
      checks: [
        {
          name: "configuration",
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const checks: HealthCheck[] = [serpApiCheck(apiKey)];
  checks.push(databaseCheck(await checkDatabaseHealth()));

  return { status: rollUp(checks), timestamp, checks };
}