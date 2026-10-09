import { getServerEnv } from "@/lib/env";
import { getDb } from "@/lib/mongodb/client";

/**
 * Read-only MongoDB reachability probe.
 *
 * Returns a result object instead of throwing so callers (health endpoint,
 * repository code, startup checks) can report a problem rather than crash.
 */

export type DatabaseHealth = {
  configured: boolean;
  reachable: boolean;
  database: string | null;
  latencyMs: number | null;
  error: string | null;
};

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  let configured = false;

  try {
    const { MONGODB_URI } = getServerEnv();
    configured = MONGODB_URI !== undefined;

    if (!MONGODB_URI) {
      return {
        configured: false,
        reachable: false,
        database: null,
        latencyMs: null,
        error: "MONGODB_URI is not configured",
      };
    }

    const db = await getDb();
    const startedAt = Date.now();
    await db.command({ ping: 1 });

    return {
      configured: true,
      reachable: true,
      database: db.databaseName,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      configured,
      reachable: false,
      database: null,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}