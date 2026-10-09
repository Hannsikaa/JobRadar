import { MongoClient, type Db } from "mongodb";

import { getServerEnv } from "@/lib/env";

/**
 * Lazy MongoDB client singleton.
 *
 * The connection is created on first use, not at import time, so that a build
 * or a page render never opens a socket. `MongoClient` owns an internal
 * connection pool, so a single client is reused across requests.
 *
 * The client is cached on `globalThis` so Next.js hot reloads in development do
 * not leak a new pool on every edit. The cache key includes the URI: changing
 * `MONGODB_URI` while the server is running yields a new client instead of
 * silently reusing one bound to the old host.
 */

const CACHE_KEY = "__jobRadarMongo";

type MongoCache = {
  uri: string;
  clientPromise: Promise<MongoClient>;
};

type MongoGlobal = typeof globalThis & {
  [CACHE_KEY]?: MongoCache;
};

const mongoGlobal = globalThis as MongoGlobal;

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "MONGODB_URI is not configured. Copy .env.example to .env.local and set a connection string.",
    );
    this.name = "DatabaseNotConfiguredError";
  }
}

/**
 * Resolves the shared client, creating it on first call.
 *
 * Declared `async` so a missing configuration surfaces as a rejected promise
 * rather than a synchronous throw: callers can rely on `.catch()` instead of
 * having to wrap the call in `try`.
 */
export async function getMongoClient(): Promise<MongoClient> {
  if (typeof window !== "undefined") {
    throw new Error(
      "getMongoClient() was called in the browser. Database access is server-side only.",
    );
  }

  const { MONGODB_URI, MONGODB_MAX_POOL_SIZE } = getServerEnv();
  if (!MONGODB_URI) {
    throw new DatabaseNotConfiguredError();
  }

  const cached = mongoGlobal[CACHE_KEY];
  if (cached && cached.uri === MONGODB_URI) {
    return cached.clientPromise;
  }

  const clientPromise = MongoClient.connect(MONGODB_URI, {
    maxPoolSize: MONGODB_MAX_POOL_SIZE,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });

  mongoGlobal[CACHE_KEY] = { uri: MONGODB_URI, clientPromise };
  return clientPromise;
}

/** Resolves the application database handle. */
export async function getDb(): Promise<Db> {
  const { MONGODB_DB_NAME } = getServerEnv();
  const client = await getMongoClient();
  return client.db(MONGODB_DB_NAME);
}

/**
 * Closes the shared client and clears the cache. Intended for graceful
 * shutdown and for tests that need a fresh client.
 */
export async function closeMongoClient(): Promise<void> {
  const cached = mongoGlobal[CACHE_KEY];
  delete mongoGlobal[CACHE_KEY];
  if (!cached) {
    return;
  }
  try {
    const client = await cached.clientPromise;
    await client.close();
  } catch {
    // Nothing to close if the connection was never established.
  }
}