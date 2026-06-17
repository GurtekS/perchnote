import { describe, expect, it } from "vitest";
import { ageWeeks, dueBucket, isSnoozed, isStale } from "../../components/tasks/TasksView";

describe("dueBucket", () => {
  const today = "2026-06-10";
  it("buckets deadlines around today", () => {
    expect(dueBucket("2026-06-09", today)).toBe("Overdue");
    expect(dueBucket("2026-06-10", today)).toBe("Today");
    expect(dueBucket("2026-06-15", today)).toBe("This week");
    expect(dueBucket("2026-07-01", today)).toBe("Later");
    expect(dueBucket(null, today)).toBe("No date");
  });
});

describe("isSnoozed", () => {
  it("hides only future snoozes — arrived dates reappear automatically", () => {
    expect(isSnoozed({ snoozed_until: "2026-06-11" }, "2026-06-10")).toBe(true);
    expect(isSnoozed({ snoozed_until: "2026-06-10" }, "2026-06-10")).toBe(false);
    expect(isSnoozed({ snoozed_until: null }, "2026-06-10")).toBe(false);
    expect(isSnoozed({}, "2026-06-10")).toBe(false);
  });
});

describe("isStale / ageWeeks", () => {
  const today = "2026-06-10";
  const base = { done: false, dropped: false, snoozed_until: null, meeting_date: "2026-05-20" };
  it("flags open items from meetings over two weeks old", () => {
    expect(isStale(base, today)).toBe(true);
    expect(isStale({ ...base, meeting_date: "2026-06-05" }, today)).toBe(false);
  });
  it("parked or finished items are never stale", () => {
    expect(isStale({ ...base, done: true }, today)).toBe(false);
    expect(isStale({ ...base, dropped: true }, today)).toBe(false);
    expect(isStale({ ...base, snoozed_until: "2026-07-01" }, today)).toBe(false);
  });
  it("ageWeeks floors and handles missing dates", () => {
    expect(ageWeeks("2026-05-20", today)).toBe(3);
    expect(ageWeeks(null, today)).toBe(null);
  });
});

describe("week ranges", () => {
  it("computes Monday-start weeks and the previous week's range", async () => {
    const { weekStart, lastWeekRange } = await import("../../components/tasks/WeekReviewCard");
    expect(weekStart("2026-06-10")).toBe("2026-06-08"); // Wednesday → that Monday
    expect(weekStart("2026-06-08")).toBe("2026-06-08"); // Monday → itself
    expect(weekStart("2026-06-14")).toBe("2026-06-08"); // Sunday → preceding Monday
    expect(lastWeekRange("2026-06-10")).toEqual(["2026-06-01", "2026-06-08"]);
  });
});
