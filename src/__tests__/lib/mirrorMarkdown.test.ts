import { describe, expect, it } from "vitest";
import { buildMirrorMarkdown } from "../../lib/mirrorMarkdown";
import type { Meeting } from "../../lib/ipc";

// Timestamps are deliberately offset-free: JS parses them as LOCAL time, so
// the expected date/time strings hold in any timezone the suite runs in.
const BASE: Meeting = {
  id: "0a3f2c44-9d1e-4f6a-8b2c-3d4e5f607182",
  title: "Untitled Meeting",
  scheduled_start: null,
  scheduled_end: null,
  actual_start: null,
  actual_end: null,
  calendar_event_id: null,
  attendees: "[]",
  location: null,
  meeting_url: null,
  platform: "unknown",
  status: "completed",
  is_pinned: false,
  is_archived: false,
  deleted_at: null,
  created_at: "2026-01-05T09:00:00",
  updated_at: "2026-01-05T09:00:00",
  device_name: null,
  system_audio_captured: false,
  note_status: "enhanced",
};

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return { ...BASE, ...overrides };
}

describe("buildMirrorMarkdown", () => {
  it("emits the full Dataview-ready frontmatter for a fully-populated meeting", () => {
    const md = buildMirrorMarkdown(
      makeMeeting({
        title: "Q2 Roadmap",
        actual_start: "2026-04-03T14:30:00",
        actual_end: "2026-04-03T15:15:00",
        scheduled_start: "2026-04-03T14:00:00",
        scheduled_end: "2026-04-03T15:00:00",
        platform: "zoom",
        location: "HQ 4th floor",
      }),
      "> **Summary:** We agreed to ship Friday.\n\n## Decisions\n\n- Ship v2\n",
      { tags: ["roadmap"], folders: ["Work"], speakers: ["Speaker 1", "Amy"] },
    );

    // Exact-bytes assertion on purpose: BOTH callers (enhance + sync-all)
    // must produce identical files, so the format itself is the contract.
    expect(md).toBe(
      [
        "---",
        'title: "Q2 Roadmap"',
        "date: 2026-04-03",
        'time: "14:30"',
        "duration_minutes: 45",
        "type: meeting",
        "platform: zoom",
        'location: "HQ 4th floor"',
        "folders: [Work]",
        "tags: [perchnote, roadmap]",
        "speakers: [Speaker 1, Amy]",
        "perchnote: perchnote://meeting/0a3f2c44-9d1e-4f6a-8b2c-3d4e5f607182",
        "id: 0a3f2c44-9d1e-4f6a-8b2c-3d4e5f607182",
        "---",
        "",
        "# Q2 Roadmap",
        "",
        "> **Summary:** We agreed to ship Friday.",
        "",
        "## Decisions",
        "",
        "- Ship v2",
        "",
      ].join("\n"),
    );
  });

  it("omits every optional key for a minimal meeting — no empty keys, ever", () => {
    const md = buildMirrorMarkdown(makeMeeting(), "body line");

    expect(md).toBe(
      [
        "---",
        'title: "Untitled Meeting"',
        "date: 2026-01-05",
        'time: "09:00"',
        "type: meeting",
        "tags: [perchnote]",
        "perchnote: perchnote://meeting/0a3f2c44-9d1e-4f6a-8b2c-3d4e5f607182",
        "id: 0a3f2c44-9d1e-4f6a-8b2c-3d4e5f607182",
        "---",
        "",
        "# Untitled Meeting",
        "",
        "body line",
        "",
      ].join("\n"),
    );
    // platform "unknown" is the not-detected sentinel, not a value.
    expect(md).not.toContain("platform:");
    expect(md).not.toContain("duration_minutes:");
    expect(md).not.toContain("location:");
    expect(md).not.toContain("folders:");
    expect(md).not.toContain("speakers:");
  });

  it("YAML-escapes titles with colons, quotes, and backslashes", () => {
    const md = buildMirrorMarkdown(
      makeMeeting({ title: 'Q2: review "phase 1" C:\\plans' }),
      "body",
    );

    expect(md).toContain('title: "Q2: review \\"phase 1\\" C:\\\\plans"');
    // The Markdown H1 keeps the raw title — escaping is YAML-only.
    expect(md).toContain('# Q2: review "phase 1" C:\\plans');
  });

  it("quotes list items YAML would mangle or re-type; plain ones stay bare", () => {
    const md = buildMirrorMarkdown(makeMeeting(), "body", {
      tags: ["q2: planning", "true", "2026", "roadmap", "  ", "roadmap"],
      speakers: ["Speaker 1", "Amy [guest]"],
    });

    // Dedupe + empty-drop, perchnote always first, risky spellings quoted.
    expect(md).toContain('tags: [perchnote, "q2: planning", "true", "2026", roadmap]');
    expect(md).toContain('speakers: [Speaker 1, "Amy [guest]"]');
  });

  it("falls back actual_start → scheduled_start → created_at for date/time", () => {
    const all = makeMeeting({
      actual_start: "2026-04-03T14:30:00",
      scheduled_start: "2026-04-02T10:00:00",
      created_at: "2026-04-01T08:15:00",
    });
    expect(buildMirrorMarkdown(all, "")).toContain("date: 2026-04-03");
    expect(buildMirrorMarkdown(all, "")).toContain('time: "14:30"');

    const scheduled = makeMeeting({
      scheduled_start: "2026-04-02T10:00:00",
      created_at: "2026-04-01T08:15:00",
    });
    expect(buildMirrorMarkdown(scheduled, "")).toContain("date: 2026-04-02");
    expect(buildMirrorMarkdown(scheduled, "")).toContain('time: "10:00"');

    const created = makeMeeting({ created_at: "2026-04-01T08:15:00" });
    expect(buildMirrorMarkdown(created, "")).toContain("date: 2026-04-01");
    expect(buildMirrorMarkdown(created, "")).toContain('time: "08:15"');
  });

  it("prefers the actual span for duration and never mixes span kinds", () => {
    // Scheduled 60m but actually ran 42m → actual wins.
    const both = makeMeeting({
      actual_start: "2026-04-03T14:30:00",
      actual_end: "2026-04-03T15:12:00",
      scheduled_start: "2026-04-03T14:00:00",
      scheduled_end: "2026-04-03T15:00:00",
    });
    expect(buildMirrorMarkdown(both, "")).toContain("duration_minutes: 42");

    // Recording never ended (no actual_end): the scheduled span still counts,
    // but actual_start must NOT pair with scheduled_end (that'd be 30m here).
    const openEnded = makeMeeting({
      actual_start: "2026-04-03T14:30:00",
      scheduled_start: "2026-04-03T14:00:00",
      scheduled_end: "2026-04-03T15:00:00",
    });
    expect(buildMirrorMarkdown(openEnded, "")).toContain("duration_minutes: 60");
  });

  it("ends a body-less mirror right after the title heading", () => {
    const md = buildMirrorMarkdown(makeMeeting({ title: "Quick note" }), "   \n");
    expect(md.endsWith("# Quick note\n")).toBe(true);
  });
});
