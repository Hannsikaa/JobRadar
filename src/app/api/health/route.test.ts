import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/health/route";
import { __resetEnvCache } from "@/lib/env";
import { checkDatabaseHealth } from "@/lib/mongodb/health";

vi.mock("@/lib/mongodb/health", () => ({
  checkDatabaseHealth: vi.fn(),
}));

const mockedCheckDatabaseHealth = vi.mocked(checkDatabaseHealth);

function setEnv(values: Partial<Record<string, string | undefined>>) {
  delete process.env.SERPAPI_API_KEY;
  delete process.env.MONGODB_URI;
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

describe("GET /api/health", () => {
  beforeEach(() => {
    __resetEnvCache();
    setEnv({});
    mockedCheckDatabaseHealth.mockReset();
    mockedCheckDatabaseHealth.mockResolvedValue({
      configured: false,
      reachable: false,
      database: null,
      latencyMs: null,
      error: "MONGODB_URI is not configured",
    });
  });

  it("returns 200 with a degraded body when nothing is configured", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body).toMatchObject({
      checks: [
        { name: "serpapi", status: "skip" },
        { name: "mongodb", status: "skip" },
      ],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 503 when a configured dependency fails", async () => {
    setEnv({ SERPAPI_API_KEY: "key", MONGODB_URI: "mongodb://127.0.0.1:27017" });
    mockedCheckDatabaseHealth.mockResolvedValue({
      configured: true,
      reachable: false,
      database: null,
      latencyMs: null,
      error: "connection refused",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("error");
    expect(body.checks).toContainEqual({
      name: "mongodb",
      status: "fail",
      detail: "connection refused",
    });
  });

  it("returns 200 and ok when everything is reachable", async () => {
    setEnv({ SERPAPI_API_KEY: "key", MONGODB_URI: "mongodb://127.0.0.1:27017" });
    mockedCheckDatabaseHealth.mockResolvedValue({
      configured: true,
      reachable: true,
      database: "job_radar",
      latencyMs: 2,
      error: null,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
  });
});