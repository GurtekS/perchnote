import { describe, expect, it } from "vitest";
import {
  currentQuarter,
  hourHistogram,
  loadHeadline,
  median,
  openLoopFacts,
  openLoopHeadline,
  peakWindowSentence,
  periodLabel,
  trendSentence,
  trendSeries,
  weeklyLoad,
} from "../../components/insights/insightsMath";
import type { ActionItem, Meeting, TopicTrend } from "../../lib/ipc";

const TODAY = "2026-06-10"; // a Wednesday; week starts 2026-06-08

function meeting(over: Partial<Meeting>): Meeting {
  return {
    id: Math.random().toString(36).slice(2),
    title: "M",
    status: "complete",
    platform: "unknown",
    attendees: "[]",
    is_pinned: false,
    is_archived: false,
    deleted_at: null,
    created_at: "2026-06-01T10:00:00Z",
    updated_at: "2026-06-01T10:00:00Z",
    scheduled_start: null,
    scheduled_end: null,
    actual_start: null,
    actual_end: null,
    calendar_event_id: null,
    location: null,
    meeting_url: null,
    ...over,
  } as unknown as Meeting;
}

function item(over: Partial<ActionItem>): ActionItem {
  return {
    meeting_id: "m1",
    meeting_title: "M",
    meeting_date: "2026-06-01T10:00:00Z",
    note_id: "n1",
    source: "generated",
    index: 0,
    task: "t",
    assignee: null,
    deadline: null,
    done: false,
    ...over,
  } as ActionItem;
}

describe("weeklyLoad", () => {
  it("buckets complete meetings into the right week with durations", () => {
    const meetings = [
      meeting({ actual_start: "2026-06-09T10:00:00", actual_end: "2026-06-09T11:30:00" }),
      meeting({ actual_start: "2026-06-08T09:00:00", actual_end: "2026-06-08T09:30:00" }),
      // Prior week
      meeting({ actual_start: "2026-06-03T10:00:00", actual_end: "2026-06-03T11:00:00" }),
      // Not complete → excluded
      meeting({ status: "upcoming", scheduled_start: "2026-06-09T15:00:00", scheduled_end: "2026-06-09T16:00:00" }),
    ];
    const weeks = weeklyLoad(meetings, TODAY, 4);
    expect(weeks).toHaveLength(4);
    expect(weeks[3]).toMatchObject({ weekStart: "2026-06-08", hours: 2, count: 2 });
    expect(weeks[2]).toMatchObject({ weekStart: "2026-06-01", hours: 1, count: 1 });
  });

  it("falls back to the scheduled span and ignores implausible spans", () => {
    const meetings = [
      meeting({ scheduled_start: "2026-06-09T10:00:00", scheduled_end: "2026-06-09T10:45:00" }),
      // 40-hour "meeting" (crash leftover) → counts as zero hours
      meeting({ actual_start: "2026-06-09T10:00:00", actual_end: "2026-06-11T02:00:00" }),
    ];
    const weeks = weeklyLoad(meetings, TODAY, 2);
    expect(weeks[1].hours).toBe(0.8);
    expect(weeks[1].count).toBe(2);
  });
});

describe("loadHeadline", () => {
  it("compares against the user's own median", () => {
    const weeks = [
      { weekStart: "a", hours: 4, count: 3 },
      { weekStart: "b", hours: 6, count: 4 },
      { weekStart: "c", hours: 5, count: 3 },
      { weekStart: "d", hours: 9, count: 6 }, // current
    ];
    const s = loadHeadline(weeks);
    expect(s).toContain("9 hours in meetings this week");
    expect(s).toContain("more than your typical 5 hours");
  });

  it("says 'about typical' inside the tolerance band", () => {
    const weeks = [
      { weekStart: "a", hours: 5, count: 3 },
      { weekStart: "b", hours: 5.2, count: 4 },
      { weekStart: "c", hours: 4.8, count: 3 },
      { weekStart: "d", hours: 5.1, count: 3 },
    ];
    expect(loadHeadline(weeks)).toContain("about your typical week");
  });

  it("avoids comparisons with too little history", () => {
    const weeks = [
      { weekStart: "a", hours: 0, count: 0 },
      { weekStart: "b", hours: 3, count: 2 },
    ];
    const s = loadHeadline(weeks);
    expect(s).toContain("3 hours");
    expect(s).not.toContain("typical");
  });
});

describe("median", () => {
  it("handles odd, even, empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("hour histogram + peak window", () => {
  it("finds the dominant 2-hour window", () => {
    const meetings = [
      ...Array.from({ length: 4 }, () =>
        meeting({ actual_start: "2026-06-09T10:15:00", actual_end: "2026-06-09T10:45:00" })),
      ...Array.from({ length: 3 }, () =>
        meeting({ actual_start: "2026-06-08T11:00:00", actual_end: "2026-06-08T11:30:00" })),
      meeting({ actual_start: "2026-06-05T15:00:00", actual_end: "2026-06-05T15:30:00" }),
    ];
    const hist = hourHistogram(meetings, TODAY);
    const s = peakWindowSentence(hist);
    expect(s).toContain("between 10 AM and noon");
  });

  it("stays silent on thin data", () => {
    const hist = hourHistogram([meeting({ actual_start: "2026-06-09T10:00:00" })], TODAY);
    expect(peakWindowSentence(hist)).toBeNull();
  });
});

describe("open loops", () => {
  it("counts open items, distinct meetings, oldest age, and recent closes", () => {
    const items = [
      item({ meeting_id: "a", meeting_date: "2026-06-08T10:00:00Z" }), // open, this week
      item({ meeting_id: "a", meeting_date: "2026-06-08T10:00:00Z", index: 1, done: true }), // closed recent
      item({ meeting_id: "b", meeting_date: "2026-05-06T10:00:00Z" }), // open, 5 weeks old
      item({ meeting_id: "c", meeting_date: "2026-06-01T10:00:00Z", dropped: true }), // dropped
      item({ meeting_id: "d", meeting_date: "2026-06-01T10:00:00Z", snoozed_until: "2026-07-01" }), // snoozed
    ];
    const f = openLoopFacts(items, TODAY);
    expect(f.open).toBe(2);
    expect(f.meetings).toBe(2);
    expect(f.oldestWeeks).toBe(5);
    expect(f.closedFromRecent).toBe(1);
    expect(f.staleCount).toBe(1);
    expect(openLoopHeadline(f)).toContain("2 open items across 2 meetings");
    expect(openLoopHeadline(f)).toContain("oldest is 5 weeks");
  });

  it("celebrates the caught-up state without inventing a score", () => {
    const f = openLoopFacts([item({ done: true, meeting_date: "2026-06-09T10:00:00Z" })], TODAY);
    expect(openLoopHeadline(f)).toContain("All caught up");
    expect(openLoopHeadline(f)).not.toMatch(/%/);
  });
});

describe("topic trends", () => {
  const trend: TopicTrend = {
    term: "pricing",
    counts: [
      { month: "2026-05", meetings: 1 },
      { month: "2026-06", meetings: 4 },
    ],
  };

  it("fills sparse months into a dense series", () => {
    const s = trendSeries(trend, TODAY, 6);
    expect(s).toHaveLength(6);
    expect(s[0].month).toBe("2026-01");
    expect(s[4]).toMatchObject({ month: "2026-05", meetings: 1 });
    expect(s[5]).toMatchObject({ month: "2026-06", meetings: 4 });
    expect(s[1].meetings).toBe(0);
  });

  it("speaks the change month-over-month", () => {
    const s = trendSeries(trend, TODAY, 6);
    expect(trendSentence("pricing", s)).toBe(
      "Pricing came up in 4 meetings in June, up from 1 in May.",
    );
  });

  it("handles a quiet month honestly", () => {
    const quiet = trendSeries({ term: "alpha", counts: [] }, TODAY, 6);
    expect(trendSentence("alpha", quiet)).toBe("Alpha hasn't come up in June.");
  });
});

describe("currentQuarter / periodLabel (plan v9 item 14)", () => {
  it("maps every month to its quarter", () => {
    expect(currentQuarter("2026-01-15")).toBe("2026-Q1");
    expect(currentQuarter("2026-03-31")).toBe("2026-Q1");
    expect(currentQuarter("2026-04-01")).toBe("2026-Q2");
    expect(currentQuarter("2026-06-10")).toBe("2026-Q2");
    expect(currentQuarter("2026-09-30")).toBe("2026-Q3");
    expect(currentQuarter("2026-10-01")).toBe("2026-Q4");
    expect(currentQuarter("2026-12-31")).toBe("2026-Q4");
  });

  it("labels quarter and year periods for humans", () => {
    expect(periodLabel("2026-Q2")).toBe("Q2 2026");
    expect(periodLabel("2026-Q4")).toBe("Q4 2026");
    expect(periodLabel("2026")).toBe("2026");
  });
});
