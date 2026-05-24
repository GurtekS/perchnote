import { describe, it, expect } from "vitest";
import { slashCommandItems, filterItems } from "../../../lib/tiptap/slashCommandItems";

describe("slashCommandItems", () => {
  it("includes the standard set", () => {
    const labels = slashCommandItems.map((i) => i.label);
    expect(labels).toEqual([
      "Heading 1", "Heading 2", "Heading 3",
      "Bulleted list", "Numbered list", "Task list",
      "Quote", "Divider", "Code block",
      "Callout — info", "Callout — warn", "Callout — tip",
      "Toggle",
    ]);
  });

  it("filterItems matches by label substring (case-insensitive)", () => {
    expect(filterItems("head").map((i) => i.label)).toEqual([
      "Heading 1", "Heading 2", "Heading 3",
    ]);
  });

  it("filterItems matches by alias", () => {
    // 'h1' is an alias for Heading 1
    expect(filterItems("h1")[0].label).toBe("Heading 1");
  });

  it("filterItems returns the full set for empty query", () => {
    expect(filterItems("")).toHaveLength(slashCommandItems.length);
  });
});
