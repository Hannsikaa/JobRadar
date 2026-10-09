import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetEnvCache,
  getClientEnv,
  getServerEnv,
  isDatabaseConfigured,
  isSerpApiConfigured,
} from "@/lib/env";

const MANAGED_KEYS = [
  "MONGODB_URI",
  "MONGODB_DB_NAME",
  "MONGODB_MAX_POOL_SIZE",
  "SERPAPI_API_KEY",
  "SERPAPI_BASE_URL",
  "NEXT_PUBLIC_APP_NAME",
] as const;

function setEnv(values: Partial<Record<(typeof MANAGED_KEYS)[number], string>>) {
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

describe("env configuration", () => {
  beforeEach(() => {
    __resetEnvCache();
    setEnv({});
  });

  afterEach(() => {
    __resetEnvCache();
    setEnv({});
  });

  it("applies documented defaults when nothing is configured", () => {
    const env = getServerEnv();

    expect(env.MONGODB_URI).toBeUndefined();
    expect(env.MONGODB_DB_NAME).toBe("job_radar");
    expect(env.MONGODB_MAX_POOL_SIZE).toBe(10);
    expect(env.SERPAPI_BASE_URL).toBe("https://serpapi.com");
  });

  it("parses a configured MongoDB and SerpApi setup", () => {
    setEnv({
      MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net",
      MONGODB_DB_NAME: "job_radar_prod",
      MONGODB_MAX_POOL_SIZE: "25",
      SERPAPI_API_KEY: "test-key",
    });

    const env = getServerEnv();

    expect(env.MONGODB_URI).toBe("mongodb+srv://user:pass@cluster.mongodb.net");
    expect(env.MONGODB_DB_NAME).toBe("job_radar_prod");
    expect(env.MONGODB_MAX_POOL_SIZE).toBe(25);
    expect(env.SERPAPI_API_KEY).toBe("test-key");
    expect(isDatabaseConfigured()).toBe(true);
    expect(isSerpApiConfigured()).toBe(true);
  });

  it("treats blank values as unset instead of failing", () => {
    setEnv({ MONGODB_URI: "   ", SERPAPI_API_KEY: "" });

    const env = getServerEnv();

    expect(env.MONGODB_URI).toBeUndefined();
    expect(env.SERPAPI_API_KEY).toBeUndefined();
    expect(isDatabaseConfigured()).toBe(false);
    expect(isSerpApiConfigured()).toBe(false);
  });

  it("rejects a MongoDB URI that is not a connection string", () => {
    setEnv({ MONGODB_URI: "localhost:27017" });

    expect(() => getServerEnv()).toThrow(/MONGODB_URI/);
    // A helper used by health checks must not throw on invalid configuration.
    expect(isDatabaseConfigured()).toBe(false);
  });

  it("rejects a database name that is unsafe as a MongoDB collection name", () => {
    setEnv({ MONGODB_DB_NAME: "job radar!" });

    expect(() => getServerEnv()).toThrow(/MONGODB_DB_NAME/);
  });

  it("coerces a numeric pool size and rejects out-of-range values", () => {
    setEnv({ MONGODB_MAX_POOL_SIZE: "5" });
    expect(getServerEnv().MONGODB_MAX_POOL_SIZE).toBe(5);

    __resetEnvCache();
    setEnv({ MONGODB_MAX_POOL_SIZE: "0" });
    expect(() => getServerEnv()).toThrow(/MONGODB_MAX_POOL_SIZE/);
  });

  it("memoizes the parsed configuration", () => {
    expect(getServerEnv()).toBe(getServerEnv());
  });

  it("reads the public app name with a default", () => {
    expect(getClientEnv().NEXT_PUBLIC_APP_NAME).toBe("Job Radar");

    setEnv({ NEXT_PUBLIC_APP_NAME: "Job Radar Dev" });
    __resetEnvCache();
    expect(getClientEnv().NEXT_PUBLIC_APP_NAME).toBe("Job Radar Dev");
  });
});