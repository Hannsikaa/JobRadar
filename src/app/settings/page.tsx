"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { userFetch } from "@/lib/identity/demo-user";
import type { JobPreferences } from "@/lib/profile/types";

/**
 * Settings — a read-only view of what the next search is actually configured
 * with. Nothing here is editable because nothing here should be: the search
 * preferences belong to the Profile Review page, and the service state belongs
 * to the environment. This page only reads the two live endpoints and shows what
 * they really say.
 *
 * - Search preferences come from `GET /api/profile`. When the search runs, the
 *   orchestrator loads this exact stored profile, so what is printed here is the
 *   contract the next SerpApi query is built from — target roles, locations,
 *   experience level, freshness window, and salary floor.
 * - Service status comes from `GET /api/health`. It reports which dependencies
 *   are configured (`pass`), not configured (`skip`), or unreachable (`fail`).
 *   The API key itself is never shown.
 *
 * Both reads go through `userFetch`, so even here the app keeps one identity per
 * browser instead of drifting onto a shared or anonymous profile.
 */

type ProfileRead =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; preferences: JobPreferences }
  | { status: "error"; message: string };

type HealthCheck = { name: string; status: "pass" | "skip" | "fail"; detail: string };

type HealthRead =
  | { status: "loading" }
  | { status: "ready"; checks: HealthCheck[]; overall: string }
  | { status: "error"; message: string };

async function readProfile(): Promise<ProfileRead> {
  try {
    const response = await userFetch("/api/profile", { cache: "no-store" });

    if (response.status === 404) {
      return { status: "missing" };
    }

    if (!response.ok) {
      return { status: "error", message: "Your stored profile could not be read." };
    }

    const body = (await response.json()) as { preferences?: JobPreferences };

    if (typeof body.preferences !== "object" || body.preferences === null) {
      return { status: "error", message: "Your stored profile could not be read." };
    }

    return { status: "ready", preferences: body.preferences };
  } catch {
    return { status: "error", message: "Could not reach the server to read your settings." };
  }
}

async function readHealth(): Promise<HealthRead> {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const body = (await response.json()) as {
      status?: string;
      checks?: HealthCheck[];
    };

    if (!Array.isArray(body.checks)) {
      return { status: "error", message: "The service status could not be read." };
    }

    return { status: "ready", checks: body.checks, overall: body.status ?? "unknown" };
  } catch {
    return { status: "error", message: "The service status could not be read." };
  }
}

function statusLabel(status: "pass" | "skip" | "fail"): string {
  switch (status) {
    case "pass":
      return "Up";
    case "skip":
      return "Not configured";
    case "fail":
      return "Down";
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-3">
      <dt className="text-sm text-zinc-400">{label}</dt>
      <dd className="text-right text-sm font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

function preferencesList(preferences: JobPreferences): { label: string; value: string }[] {
  const roles = preferences.targetRoles.join(", ");
  const locations = preferences.locations.join(", ");
  const salary =
    preferences.minimumSalary === undefined
      ? "Not set"
      : `${preferences.minimumSalary} ${preferences.salaryCurrency ?? ""}`.trim();

  return [
    { label: "Target roles", value: roles.length === 0 ? "None yet" : roles },
    { label: "Locations", value: locations.length === 0 ? "None yet" : locations },
    {
      label: "Experience level",
      value:
        preferences.experienceLevel === "mid"
          ? "Mid-level"
          : preferences.experienceLevel.charAt(0).toUpperCase() + preferences.experienceLevel.slice(1),
    },
    { label: "Freshness window", value: `${preferences.freshnessDays} day(s)` },
    { label: "Salary floor", value: salary },
    { label: "Job types", value: preferences.jobTypes.length === 0 ? "Any" : preferences.jobTypes.join(", ") },
    { label: "Remote only", value: preferences.remoteOnly ? "Yes" : "No" },
  ];
}

export default function SettingsPage() {
  const [profile, setProfile] = useState<ProfileRead>({ status: "loading" });
  const [health, setHealth] = useState<HealthRead>({ status: "loading" });

  useEffect(() => {
    let active = true;

    void Promise.all([readProfile(), readHealth()]).then(([nextProfile, nextHealth]) => {
      if (!active) {
        return;
      }

      setProfile(nextProfile);
      setHealth(nextHealth);
    });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-400">
          Configuration
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Settings</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-zinc-400">
          The configuration the next search uses. Preferences are edited on the{" "}
          <Link
            href="/profile-review"
            className="font-medium text-emerald-400 underline-offset-4 hover:underline"
          >
            Profile Review
          </Link>{" "}
          page; this page only reads live state.
        </p>
      </header>

      <section
        aria-labelledby="search-config-heading"
        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-5 sm:p-6"
      >
        <h2 id="search-config-heading" className="text-xl font-semibold tracking-tight text-zinc-50">
          Search configuration
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          The stored profile the next scan is built from. Each value below is the same one the search
          reads when it plans and runs the queries.
        </p>

        <dl className="mt-4 divide-y divide-[var(--border)]">
          {profile.status === "loading" ? (
            <div role="status" className="py-3 text-sm text-zinc-400">
              Reading stored profile…
            </div>
          ) : null}

          {profile.status === "missing" ? (
            <div className="flex flex-col gap-2 py-3">
              <p className="text-sm text-zinc-400">No profile stored for this browser yet.</p>
              <Link
                href="/profile-review"
                className="w-fit text-sm font-medium text-emerald-400 hover:text-emerald-300"
              >
                Create a profile on Profile Review →
              </Link>
            </div>
          ) : null}

          {profile.status === "error" ? (
            <div role="alert" className="py-3 text-sm text-red-400">
              {profile.message}
            </div>
          ) : null}

          {profile.status === "ready"
            ? preferencesList(profile.preferences).map((item) => (
                <Field key={item.label} label={item.label} value={item.value} />
              ))
            : null}
        </dl>
      </section>

      <section
        aria-labelledby="service-status-heading"
        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]/60 p-5 sm:p-6"
      >
        <h2 id="service-status-heading" className="text-xl font-semibold tracking-tight text-zinc-50">
          Service status
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Live report from the health endpoint. The SerpApi key is never shown — only whether one is
          configured and reachable.
        </p>

        <dl className="mt-4 divide-y divide-[var(--border)]">
          {health.status === "loading" ? (
            <div role="status" className="py-3 text-sm text-zinc-400">
              Checking services…
            </div>
          ) : null}

          {health.status === "error" ? (
            <div role="alert" className="py-3 text-sm text-red-400">
              {health.message}
            </div>
          ) : null}

          {health.status === "ready"
            ? health.checks.map((check) => (
                <div key={check.name} className="flex items-baseline justify-between gap-6 py-3">
                  <dt className="text-sm text-zinc-400">{check.name}</dt>
                  <dd className="flex items-baseline gap-3">
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={
                          "size-1.5 rounded-full " +
                          (check.status === "pass"
                            ? "bg-emerald-400"
                            : check.status === "fail"
                              ? "bg-red-400"
                              : "bg-zinc-500")
                        }
                      />
                      <span
                        className={
                          check.status === "pass"
                            ? "text-sm font-medium text-emerald-300"
                            : check.status === "fail"
                              ? "text-sm font-medium text-red-300"
                              : "text-sm font-medium text-zinc-400"
                        }
                      >
                        {statusLabel(check.status)}
                      </span>
                    </span>
                    <span
                      className="max-w-xs truncate font-mono text-[13px] text-zinc-500"
                      title={check.detail}
                    >
                      {check.detail}
                    </span>
                  </dd>
                </div>
              ))
            : null}
        </dl>
      </section>
    </div>
  );
}