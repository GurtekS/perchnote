// src/__tests__/lib/tiptap/formatDeadline.test.ts
import { describe, it, expect } from "vitest";
import { formatDeadline } from "../../../lib/tiptap/formatDeadline";

describe("formatDeadline", () => {
  const NOW = new Date("2026-05-20T10:00:00Z");

  it("returns short-absolute for dates past 7 days away", () => {
    expect(formatDeadline("2026-08-05T00:00:00Z", NOW)).toBe("Aug 5");
  });

  it("returns 'Tomorrow' for the next day", () => {
    expect(formatDeadline("2026-05-21T15:00:00Z", NOW)).toBe("Tomorrow");
  });

  it("returns weekday name when within 7 days", () => {
    expect(formatDeadline("2026-05-23T10:00:00Z", NOW)).toMatch(/^Sat/); // 2026-05-23 is Saturday
  });

  it("returns empty string for null or invalid input", () => {
    expect(formatDeadline(null, NOW)).toBe("");
    expect(formatDeadline("not-a-date", NOW)).toBe("");
  });
});
