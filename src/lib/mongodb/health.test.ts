import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCache } from "@/lib/env";
import { checkDatabaseHealth } from "@/lib/mongodb/health";

// `vi.hoisted` shares the mock across the hoisted `vi.mock` factory and the
// test bodies, so the fake `db.command` really is the same `ping` spy.
const { ping } = vi.hoisted(() => ({ ping: vi.fn() }));

vi.mock("@/lib/mongodb/client", () => ({
  getDb: vi.fn(async () => ({ command: ping, databaseName: "job_radar" })),
  DatabaseNotConfiguredError: class DatabaseNotConfiguredError extends Error {},
}));

function setEnv(values: Partial<Record<string, string | undefined>>) {
  for (const key of ["MONGODB_URI", "MONGODB_DB_NAME", "SERPAPI_API_KEY"]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

describe("checkDatabaseHealth", () => {
  beforeEach(() => {
    __resetEnvCache();
    setEnv({});
    ping.mockReset();
  });

  it("reports the database as not configured without touching the network", async () => {
    const health = await checkDatabaseHealth();

    expect(health.configured).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(/MONGODB_URI/);
    expect(ping).not.toHaveBeenCalled();
  });

  it("reports a reachable database with latency when the ping succeeds", async () => {
    setEnv({ MONGODB_URI: "mongodb://127.0.0.1:27017" });
    ping.mockResolvedValue({ ok: 1 });

    const health = await checkDatabaseHealth();

    expect(health.configured).toBe(true);
    expect(health.reachable).toBe(true);
    expect(health.database).toBe("job_radar");
    expect(health.error).toBeNull();
    expect(ping).toHaveBeenCalledWith({ ping: 1 });
  });

  it("returns an error result instead of throwing when the ping fails", async () => {
    setEnv({ MONGODB_URI: "mongodb://127.0.0.1:27017" });
    ping.mockRejectedValue(new Error("connection refused"));

    const health = await checkDatabaseHealth();

    expect(health.configured).toBe(true);
    expect(health.reachable).toBe(false);
    expect(health.error).toBe("connection refused");
  });

  it("reports invalid configuration as unconfigured rather than crashing", async () => {
    setEnv({ MONGODB_URI: "not-a-mongo-uri" });

    const health = await checkDatabaseHealth();

    expect(health.configured).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(/MONGODB_URI/);
  });
});