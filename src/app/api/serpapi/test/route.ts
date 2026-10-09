import { NextResponse } from "next/server";

import { getServerEnv } from "@/lib/env";
import { searchGoogleJobs, type SerpApiSearchResponse } from "@/lib/serpapi/client";
import { resolveSearchLocale } from "@/lib/serpapi/locale";

export const dynamic = "force-dynamic";

export type SerpapiTestSuccess = {
  ok: true;
  query: string;
  location: string;
  gl: string;
  hl: string;
  result: SerpApiSearchResponse;
};

export type SerpapiTestError = {
  ok: false;
  error: string;
  detail?: string;
};

export type SerpapiTestResponse = SerpapiTestSuccess | SerpapiTestError;

/**
 * Strips the API key from any text headed for a response body. Provider error
 * messages echo the full request URL, key included; that must never leave the
 * server even in a diagnostic route.
 */
function redactApiKeys(text: string): string {
  return text.replace(/api_key=[^&\s]+/gi, "api_key=REDACTED");
}

export async function GET(request: Request) {
  let apiKey: string | undefined;
  try {
    apiKey = getServerEnv().SERPAPI_API_KEY;
  } catch {
    apiKey = undefined;
  }

  if (apiKey === undefined) {
    const payload: SerpapiTestError = {
      ok: false,
      error: "SERPAPI_API_KEY missing on server",
    };
    return NextResponse.json(payload, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query") ?? "software engineer";
  const location = searchParams.get("location") ?? "San Francisco, CA";
  // Country-aware default: Berlin-type locations need gl=hl of their own
  // country or SerpApi returns zero results. Explicit overrides still win.
  const locale = resolveSearchLocale(location);
  const gl = searchParams.get("country") ?? locale.gl;
  const hl = searchParams.get("language") ?? locale.hl;

  try {
    const result = await searchGoogleJobs({ q: query, location, gl, hl });

    const payload: SerpapiTestSuccess = {
      ok: true,
      query,
      location,
      gl,
      hl,
      result,
    };
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const payload: SerpapiTestError = {
      ok: false,
      error: "SerpApi request failed",
      detail: redactApiKeys(message),
    };
    return NextResponse.json(payload, { status: 502 });
  }
}
