import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCache } from "@/lib/env";
import {
  closeMongoClient,
  DatabaseNotConfiguredError,
  getDb,
  getMongoClient,
} from "@/lib/mongodb/client";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("mongodb", () => ({
  MongoClient: { connect },
}));

function fakeClient() {
  return {
    db: vi.fn((name: string) => ({ databaseName: name })),
    close: vi.fn(async () => undefined),
  };
}

function setEnv(values: Partial<Record<string, string | undefined>>) {
  for (const key of ["MONGODB_URI", "MONGODB_DB_NAME", "MONGODB_MAX_POOL_SIZE"]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

describe("mongodb client singleton", () => {
  beforeEach(() => {
    __resetEnvCache();
    setEnv({ MONGODB_URI: "mongodb://127.0.0.1:27017" });
    connect.mockReset();
  });

  afterEach(async () => {
    await closeMongoClient();
    __resetEnvCache();
    setEnv({});
  });

  it("does not connect at import time", () => {
    expect(connect).not.toHaveBeenCalled();
  });

  it("throws a descriptive error when MONGODB_URI is missing", async () => {
    setEnv({});
    await expect(getMongoClient()).rejects.toBeInstanceOf(
      DatabaseNotConfiguredError,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects lazily with the configured pool size and reuses the client", async () => {
    const client = fakeClient();
    connect.mockResolvedValue(client);

    const first = await getMongoClient();
    const second = await getMongoClient();

    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("mongodb://127.0.0.1:27017", {
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    });
  });

  it("honours a configured pool size", async () => {
    connect.mockResolvedValue(fakeClient());
    setEnv({ MONGODB_URI: "mongodb://127.0.0.1:27017", MONGODB_MAX_POOL_SIZE: "3" });

    await getMongoClient();

    expect(connect).toHaveBeenCalledWith(
      "mongodb://127.0.0.1:27017",
      expect.objectContaining({ maxPoolSize: 3 }),
    );
  });

  it("does not reuse a client bound to a previous URI", async () => {
    const first = fakeClient();
    connect.mockResolvedValueOnce(first);
    await getMongoClient();

    __resetEnvCache();
    setEnv({ MONGODB_URI: "mongodb://127.0.0.1:27018" });
    const second = fakeClient();
    connect.mockResolvedValueOnce(second);

    await expect(getMongoClient()).resolves.toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("returns a handle for the configured database name", async () => {
    const client = fakeClient();
    connect.mockResolvedValue(client);
    setEnv({
      MONGODB_URI: "mongodb://127.0.0.1:27017",
      MONGODB_DB_NAME: "job_radar_test",
    });

    const db = await getDb();

    expect(db.databaseName).toBe("job_radar_test");
    expect(client.db).toHaveBeenCalledWith("job_radar_test");
  });

  it("closes and clears the cached client", async () => {
    const client = fakeClient();
    connect.mockResolvedValue(client);
    await getMongoClient();

    await closeMongoClient();
    expect(client.close).toHaveBeenCalledTimes(1);

    await getMongoClient();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("is safe to close when no client was ever created", async () => {
    await expect(closeMongoClient()).resolves.toBeUndefined();
  });
});