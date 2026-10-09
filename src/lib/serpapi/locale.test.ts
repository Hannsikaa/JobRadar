import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEARCH_LOCALE,
  resolveSearchLocale,
  toProviderLocation,
} from "@/lib/serpapi/locale";

describe("resolveSearchLocale", () => {
  it("maps 'City, Country' to the country's own Google default", () => {
    expect(resolveSearchLocale("Berlin, Germany")).toEqual({ gl: "de", hl: "de" });
    expect(resolveSearchLocale("London, United Kingdom")).toEqual({ gl: "uk", hl: "en" });
    expect(resolveSearchLocale("Paris, France")).toEqual({ gl: "fr", hl: "fr" });
    expect(resolveSearchLocale("Tokyo, Japan")).toEqual({ gl: "jp", hl: "ja" });
    expect(resolveSearchLocale("São Paulo, Brazil")).toEqual({ gl: "br", hl: "pt" });
    expect(resolveSearchLocale("Toronto, Canada")).toEqual({ gl: "ca", hl: "en" });
    expect(resolveSearchLocale("Amsterdam, Netherlands")).toEqual({ gl: "nl", hl: "nl" });
  });

  it("keeps US locations at the default", () => {
    expect(resolveSearchLocale("San Francisco, CA")).toEqual(DEFAULT_SEARCH_LOCALE);
    expect(resolveSearchLocale("New York, United States")).toEqual(DEFAULT_SEARCH_LOCALE);
    expect(resolveSearchLocale("Austin, USA")).toEqual(DEFAULT_SEARCH_LOCALE);
  });

  it("keeps India and Singapore on English", () => {
    expect(resolveSearchLocale("Hyderabad, India")).toEqual({ gl: "in", hl: "en" });
    expect(resolveSearchLocale("Singapore")).toEqual({ gl: "sg", hl: "en" });
  });

  it("resolves bare well-known cities", () => {
    expect(resolveSearchLocale("Berlin")).toEqual({ gl: "de", hl: "de" });
    expect(resolveSearchLocale("London")).toEqual({ gl: "uk", hl: "en" });
    expect(resolveSearchLocale("Bengaluru")).toEqual({ gl: "in", hl: "en" });
    expect(resolveSearchLocale("München")).toEqual({ gl: "de", hl: "de" });
  });

  it("falls back to us/en for unrecognized input", () => {
    expect(resolveSearchLocale("Atlantis")).toEqual(DEFAULT_SEARCH_LOCALE);
    expect(resolveSearchLocale("")).toEqual(DEFAULT_SEARCH_LOCALE);
    expect(resolveSearchLocale("Nowhere, Narnia")).toEqual(DEFAULT_SEARCH_LOCALE);
  });

  it("does not map US states that collide with country names", () => {
    // "Georgia" the country exists, but a bare "Georgia" (US state) is left
    // at the default because we only map it via an explicit country segment.
    expect(resolveSearchLocale("Atlanta, Georgia")).toEqual(DEFAULT_SEARCH_LOCALE);
    expect(resolveSearchLocale("Georgia, United States")).toEqual(DEFAULT_SEARCH_LOCALE);
  });

  it("handles case and whitespace variations", () => {
    expect(resolveSearchLocale("  berlin , germany ")).toEqual({ gl: "de", hl: "de" });
    expect(resolveSearchLocale("LONDON, UK")).toEqual({ gl: "uk", hl: "en" });
    expect(resolveSearchLocale("Deutschland")).toEqual({ gl: "de", hl: "de" });
  });
});

describe("toProviderLocation", () => {
  it("passes real places through unchanged", () => {
    expect(toProviderLocation("Hyderabad")).toBe("Hyderabad");
    expect(toProviderLocation("Berlin, Germany")).toBe("Berlin, Germany");
    expect(toProviderLocation("  Remote, Oregon  ")).toBe("Remote, Oregon");
  });

  it("drops non-geographic phrases that google_jobs rejects", () => {
    expect(toProviderLocation("worldwide")).toBeUndefined();
    expect(toProviderLocation("World Wide")).toBeUndefined();
    expect(toProviderLocation("Global")).toBeUndefined();
    expect(toProviderLocation("Anywhere")).toBeUndefined();
    expect(toProviderLocation("Remote")).toBeUndefined();
    expect(toProviderLocation("Remote in Europe")).toBeUndefined();
    expect(toProviderLocation("Work from home")).toBeUndefined();
    expect(toProviderLocation("WFH")).toBeUndefined();
  });

  it("treats empty input as no location", () => {
    expect(toProviderLocation(undefined)).toBeUndefined();
    expect(toProviderLocation("")).toBeUndefined();
    expect(toProviderLocation("   ")).toBeUndefined();
  });
});
