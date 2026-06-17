import { describe, expect, it } from "vitest";
import { layoutDayEvents } from "../../lib/calendarLayout";

interface Ev { id: string; start: number; end: number }
const lay = (events: Ev[]) =>
  layoutDayEvents(events, (e) => e.start, (e) => e.end);
const byId = (laid: ReturnType<typeof lay>, id: string) =>
  laid.find((l) => l.item.id === id)!;

describe("layoutDayEvents", () => {
  it("non-overlapping events all get full width", () => {
    const laid = lay([
      { id: "a", start: 60, end: 120 },
      { id: "b", start: 120, end: 180 },
      { id: "c", start: 300, end: 360 },
    ]);
    for (const l of laid) {
      expect(l.col).toBe(0);
      expect(l.cols).toBe(1);
    }
  });

  it("two concurrent events split the column in half", () => {
    const laid = lay([
      { id: "a", start: 60, end: 120 },
      { id: "b", start: 90, end: 150 },
    ]);
    expect(byId(laid, "a")).toMatchObject({ col: 0, cols: 2 });
    expect(byId(laid, "b")).toMatchObject({ col: 1, cols: 2 });
  });

  it("a back-to-back event reuses a freed track", () => {
    // a [60,120) and b [90,150) overlap; c starts at 120 — a's track is free.
    const laid = lay([
      { id: "a", start: 60, end: 120 },
      { id: "b", start: 90, end: 150 },
      { id: "c", start: 120, end: 180 },
    ]);
    expect(byId(laid, "c")).toMatchObject({ col: 0, cols: 2 });
    expect(byId(laid, "b").cols).toBe(2);
  });

  it("chain overlaps share one cluster width even without mutual overlap", () => {
    // a overlaps b, b overlaps c, a doesn't touch c — all one cluster of 2 tracks.
    const laid = lay([
      { id: "a", start: 0, end: 60 },
      { id: "b", start: 30, end: 90 },
      { id: "c", start: 60, end: 120 },
    ]);
    expect(laid.every((l) => l.cols === 2)).toBe(true);
  });

  it("triple overlap yields three tracks; separate clusters stay independent", () => {
    const laid = lay([
      { id: "a", start: 0, end: 90 },
      { id: "b", start: 10, end: 80 },
      { id: "c", start: 20, end: 70 },
      { id: "later", start: 200, end: 260 },
    ]);
    expect(byId(laid, "a").cols).toBe(3);
    expect(new Set([byId(laid, "a").col, byId(laid, "b").col, byId(laid, "c").col]).size).toBe(3);
    expect(byId(laid, "later")).toMatchObject({ col: 0, cols: 1 });
  });

  it("zero-duration events still occupy a track", () => {
    const laid = lay([
      { id: "a", start: 60, end: 60 },
      { id: "b", start: 60, end: 90 },
    ]);
    expect(byId(laid, "a").cols).toBe(2);
  });
});
