import { describe, expect, it } from "vitest";

import {
  isFreshForWindow,
  isWithinFreshnessWindow,
  parsePostedAge,
} from "@/lib/jobs/freshness";

describe("isFreshForWindow", () => {
  it("never marks an unknown posting date as fresh", () => {
    expect(isFreshForWindow(null, 1)).toBe(false);
    expect(isFreshForWindow(null, 3)).toBe(false);
    expect(isFreshForWindow(null, 7)).toBe(false);
    expect(isFreshForWindow(null, 14)).toBe(false);
  });

  it("marks known dates inside the window as fresh", () => {
    expect(isFreshForWindow({ days: 0, text: "today" }, 1)).toBe(true);
    expect(isFreshForWindow({ days: 1, text: "1 day ago" }, 1)).toBe(true);
    expect(isFreshForWindow({ days: 3, text: "3 days ago" }, 7)).toBe(true);
  });

  it("marks known dates outside the window as not fresh", () => {
    expect(isFreshForWindow({ days: 2, text: "2 days ago" }, 1)).toBe(false);
    expect(isFreshForWindow({ days: 8, text: "8 days ago" }, 7)).toBe(false);
    expect(isFreshForWindow({ days: 30, text: "30 days ago" }, 14)).toBe(false);
  });
});

describe("isWithinFreshnessWindow", () => {
  it("retains unknown-date jobs so they are not silently hidden", () => {
    expect(isWithinFreshnessWindow(null, 1)).toBe(true);
    expect(isWithinFreshnessWindow(null, 14)).toBe(true);
  });

  it("applies the same day boundary as freshness for known dates", () => {
    expect(isWithinFreshnessWindow({ days: 7, text: "7 days ago" }, 7)).toBe(true);
    expect(isWithinFreshnessWindow({ days: 8, text: "8 days ago" }, 7)).toBe(false);
  });
});

describe("parsePostedAge", () => {
  it("returns null for text it cannot understand", () => {
    expect(parsePostedAge(undefined)).toBeNull();
    expect(parsePostedAge("")).toBeNull();
    expect(parsePostedAge("whenever")).toBeNull();
  });

  it("reads relative text into whole days", () => {
    expect(parsePostedAge("Just posted")).toMatchObject({ days: 0 });
    expect(parsePostedAge("2 days ago")).toMatchObject({ days: 2 });
    expect(parsePostedAge("3 weeks ago")).toMatchObject({ days: 21 });
    expect(parsePostedAge("yesterday")).toMatchObject({ days: 1 });
  });
});
