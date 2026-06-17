import { describe, expect, it } from "vitest";
import { extractFilterChips } from "../../lib/searchFilterHints";

describe("extractFilterChips (client mirror of the Rust grammar)", () => {
  it("returns nothing for plain queries", () => {
    expect(extractFilterChips("quarterly budget")).toEqual([]);
    expect(extractFilterChips('"a phrase" and word*')).toEqual([]);
  });

  it("detects each filter key, case-insensitively", () => {
    const chips = extractFilterChips("SPEAKER:Amy folder:Work budget");
    expect(chips).toEqual([
      { key: "speaker", value: "amy", valid: true },
      { key: "folder", value: "work", valid: true },
    ]);
  });

  it("groups quoted filter values", () => {
    const chips = extractFilterChips('folder:"Client Work" sync');
    expect(chips).toEqual([{ key: "folder", value: "client work", valid: true }]);
  });

  it("marks malformed dates invalid — the backend drops them", () => {
    const chips = extractFilterChips("budget before:junk after:2026-13-40");
    expect(chips).toEqual([
      { key: "before", value: "junk", valid: false },
      { key: "after", value: "2026-13-40", valid: false },
    ]);
    expect(extractFilterChips("x before:2026-06-01")[0]).toMatchObject({ valid: true });
  });

  it("keeps the last duplicate, like the backend", () => {
    const chips = extractFilterChips("speaker:amy speaker:bob x");
    expect(chips).toEqual([{ key: "speaker", value: "bob", valid: true }]);
  });

  it("ignores empty filter values", () => {
    expect(extractFilterChips("speaker: budget")).toEqual([]);
  });
});
