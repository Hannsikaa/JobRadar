import type { Metadata } from "next";

import { JobDiscovery } from "@/components/job-discovery";
import { getClientEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "Workflow",
  description:
    "Upload a resume, review the profile it builds, search live Google Jobs, and rank the matches.",
};

/**
 * Workflow — the actual tool.
 *
 * The landing page explains the product; this page runs it. It is the same
 * discovery experience that used to live at `/`, now behind a dedicated route so
 * the marketing page and the working page do not have to compromise with each
 * other.
 */
export default function WorkflowPage() {
  const { NEXT_PUBLIC_APP_NAME } = getClientEnv();

  return (
    <div className="flex flex-col gap-10" aria-label={NEXT_PUBLIC_APP_NAME}>
      <JobDiscovery />
    </div>
  );
}
