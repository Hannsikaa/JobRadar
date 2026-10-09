import { getHealthReport } from "@/lib/health";

/**
 * GET /api/health — dependency status for operators and uptime checks.
 *
 * Returns 503 only when something is actually broken. Missing optional
 * configuration reports `degraded` with 200, because an unconfigured key is a
 * setup state, not an outage.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await getHealthReport();

  return Response.json(report, {
    status: report.status === "error" ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}