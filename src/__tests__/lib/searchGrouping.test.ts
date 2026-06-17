import { describe, expect, it } from "vitest";
import {
  formatMatchTimestamp,
  groupSearchResults,
  meetingDateLabel,
} from "../../lib/searchGrouping";
import type { Meeting, SearchResult } from "../../lib/ipc";

function meeting(over: Partial<Meeting> & Pick<Meeting, "id" | "title">): Meeting {
  return {
    scheduled_start: null,
    scheduled_end: null,
    actual_start: null,
    actual_end: null,
    calendar_event_id: null,
    attendees: "[]",
    location: null,
    meeting_url: null,
    platform: "manual",
    status: "completed",
    is_pinned: false,
    is_archived: false,
    deleted_at: null,
    created_at: "2026-06-01T12:00:00Z",
    updated_at: "2026-06-01T12:00:00Z",
    device_name: null,
    system_audio_captured: false,
    note_status: "none",
    ...over,
  };
}

describe("formatMatchTimestamp", () => {
  it("formats m:ss with zero-padded seconds", () => {
    expect(formatMatchTimestamp(0)).toBe("0:00");
    expect(formatMatchTimestamp(59_999)).toBe("0:59");
    expect(formatMatchTimestamp(754_000)).toBe("12:34");
  });

  it("does not wrap minutes at 60 (matches timestampChip convention)", () => {
    expect(formatMatchTimestamp(3_725_000)).toBe("62:05");
  });

  it("clamps negatives to 0:00", () => {
    expect(formatMatchTimestamp(-500)).toBe("0:00");
  });
});

describe("meetingDateLabel", () => {
  it("prefers actual_start, then scheduled_start, then created_at", () => {
    // T12:00:00Z keeps the calendar day stable across test-runner timezones.
    const m = meeting({
      id: "m1",
      title: "T",
      actual_start: "2026-06-03T12:00:00Z",
      scheduled_start: "2026-06-04T12:00:00Z",
    });
    expect(meetingDateLabel(m)).toMatch(/3/);
    expect(meetingDateLabel({ ...m, actual_start: null })).toMatch(/4/);
    expect(
      meetingDateLabel({ ...m, actual_start: null, scheduled_start: null }),
    ).toMatch(/1/);
  });

  it("returns null for unknown meetings and unparseable dates", () => {
    expect(meetingDateLabel(undefined)).toBeNull();
    expect(
      meetingDateLabel(meeting({ id: "m1", title: "T", created_at: "not-a-date" })),
    ).toBeNull();
  });
});

describe("groupSearchResults", () => {
  const results: SearchResult[] = [
    { meeting_id: "m1", match_source: "title", snippet: "Q2 Roadmap" },
    {
      meeting_id: "m2",
      match_source: "transcript",
      snippet: "ship the roadmap in April",
      match_start_ms: 754_000,
    },
    { meeting_id: "m1", match_source: "notes", snippet: "roadmap follow-ups" },
  ];

  it("groups by meeting in first-appearance (relevance) order, rows in arrival order", () => {
    const groups = groupSearchResults(results, [
      meeting({ id: "m1", title: "Q2 Roadmap" }),
      meeting({ id: "m2", title: "Standup" }),
    ]);
    expect(groups.map((g) => g.meetingId)).toEqual(["m1", "m2"]);
    expect(groups[0].rows.map((r) => r.match_source)).toEqual(["title", "notes"]);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("takes the header title and date from the meetings cache", () => {
    const groups = groupSearchResults(results, [
      meeting({ id: "m1", title: "Q2 Roadmap (cached)", actual_start: "2026-06-03T12:00:00Z" }),
    ]);
    expect(groups[0].title).toBe("Q2 Roadmap (cached)");
    expect(groups[0].dateLabel).toMatch(/3/);
  });

  it("falls back to the title-arm snippet, then a placeholder, for uncached meetings", () => {
    const groups = groupSearchResults(results, []);
    // m1 has a title hit — its snippet IS the title.
    expect(groups[0].title).toBe("Q2 Roadmap");
    expect(groups[0].dateLabel).toBeNull();
    // m2 only matched on transcript; nothing carries its title.
    expect(groups[1].title).toBe("Untitled meeting");
  });

  it("returns no groups for no results", () => {
    expect(groupSearchResults([], [])).toEqual([]);
  });
});
