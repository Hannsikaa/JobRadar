import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCache } from "@/lib/env";
import { getHealthReport } from "@/lib/health";
import { checkDatabaseHealth } from "@/lib/mongodb/health";

vi.mock("@/lib/mongodb/health", () => ({
  checkDatabaseHealth: vi.fn(),
}));

const mockedCheckDatabaseHealth = vi.mocked(checkDatabaseHealth);

const REACHABLE = {
  configured: true,
  reachable: true,
  database: "job_radar",
  latencyMs: 3,
  error: null,
};

const UNCONFIGURED = {
  configured: false,
  reachable: false,
  database: null,
  latencyMs: null,
  error: "MONGODB_URI is not configured",
};

const UNREACHABLE = {
  configured: true,
  reachable: false,
  database: null,
  latencyMs: null,
  error: "connection refused",
};

function setEnv(values: Partial<Record<string, string | undefined>>) {
  delete process.env.MONGODB_URI;
  delete process.env.SERPAPI_API_KEY;
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

describe("getHealthReport", () => {
  beforeEach(() => {
    __resetEnvCache();
    setEnv({});
    mockedCheckDatabaseHealth.mockReset();
  });

  it("is ok when every dependency is configured and reachable", async () => {
    setEnv({ SERPAPI_API_KEY: "key" });
    mockedCheckDatabaseHealth.mockResolvedValue(REACHABLE);

    const report = await getHealthReport();

    expect(report.status).toBe("ok");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(Date.parse(report.timestamp)).not.toBeNaN();
  });

  it("is degraded, not an error, when optional services are unset", async () => {
    mockedCheckDatabaseHealth.mockResolvedValue(UNCONFIGURED);

    const report = await getHealthReport();

    expect(report.status).toBe("degraded");
    expect(report.checks).toEqual([
      { name: "serpapi", status: "skip", detail: expect.stringContaining("SERPAPI") },
      { name: "mongodb", status: "skip", detail: expect.any(String) },
    ]);
  });

  it("is an error when a configured database is unreachable", async () => {
    setEnv({ SERPAPI_API_KEY: "key" });
    mockedCheckDatabaseHealth.mockResolvedValue(UNREACHABLE);

    const report = await getHealthReport();

    expect(report.status).toBe("error");
    expect(report.checks).toContainEqual({
      name: "mongodb",
      status: "fail",
      detail: "connection refused",
    });
  });

  it("never exposes the SerpApi key in its output", async () => {
    setEnv({ SERPAPI_API_KEY: "super-secret-key" });
    mockedCheckDatabaseHealth.mockResolvedValue(REACHABLE);

    const report = await getHealthReport();

    expect(JSON.stringify(report)).not.toContain("super-secret-key");
  });

  it("reports invalid environment configuration as an error", async () => {
    setEnv({ MONGODB_URI: "localhost:27017" });
    mockedCheckDatabaseHealth.mockResolvedValue(UNCONFIGURED);

    const report = await getHealthReport();

    expect(report.status).toBe("error");
    expect(report.checks[0]).toMatchObject({ name: "configuration", status: "fail" });
  });
});