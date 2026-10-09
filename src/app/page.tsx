import type { Metadata } from "next";

import { Landing } from "@/components/landing";
import { getClientEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "Job Radar",
  description:
    "Personalized job and internship discovery with transparent match reasons and freshness filtering.",
};

export default function Home() {
  // Validated here so a misconfigured client environment fails loudly at
  // render, rather than surfacing as an odd label much later.
  const { NEXT_PUBLIC_APP_NAME } = getClientEnv();

  return (
    <div className="flex flex-col gap-10" aria-label={NEXT_PUBLIC_APP_NAME}>
      <Landing />
    </div>
  );
}
