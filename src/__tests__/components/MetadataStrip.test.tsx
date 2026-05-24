// src/__tests__/components/MetadataStrip.test.tsx
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MetadataStrip } from "../../components/meeting/MetadataStrip";
import { Meeting } from "../../lib/ipc";

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    title: "Test",
    scheduled_start: null,
    scheduled_end: null,
    actual_start: null,
    actual_end: null,
    calendar_event_id: null,
    attendees: "[]",
    location: null,
    meeting_url: null,
    platform: "unknown",
    status: "upcoming",
    is_pinned: false,
    is_archived: false,
    deleted_at: null,
    created_at: "2026-05-20T10:00:00Z",
    updated_at: "2026-05-20T10:00:00Z",
    device_name: null,
    system_audio_captured: false,
    note_status: "none",
    ...overrides,
  };
}

describe("MetadataStrip", () => {
  it("renders date, duration, attendees, location on a single text line", () => {
    const meeting = makeMeeting({
      scheduled_start: "2026-07-17T14:00:00Z",
      scheduled_end:   "2026-07-17T14:45:00Z",
      attendees: JSON.stringify(["Alice", "Bob", "Carol"]),
      location: "Conference Room A",
    });
    render(<MetadataStrip meeting={meeting} onSaved={vi.fn()} />);
    expect(screen.getByText(/Alice, Bob, Carol/)).toBeInTheDocument();
    expect(screen.getByText(/Conference Room A/)).toBeInTheDocument();
    expect(screen.getByText(/45m/)).toBeInTheDocument();
  });

  it("collapses attendees over 4 with a +N suffix", () => {
    const meeting = makeMeeting({
      attendees: JSON.stringify(["A", "B", "C", "D", "E", "F"]),
    });
    render(<MetadataStrip meeting={meeting} onSaved={vi.fn()} />);
    expect(screen.getByText(/A, B, C, D \+2/)).toBeInTheDocument();
  });

  it("shows 'No date set' italic placeholder when no date", () => {
    const meeting = makeMeeting({ created_at: "" });
    render(<MetadataStrip meeting={meeting} onSaved={vi.fn()} />);
    expect(screen.getByText(/No date set/)).toBeInTheDocument();
  });

  it("exposes the metadata editor through a named button", () => {
    render(<MetadataStrip meeting={makeMeeting()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit meeting details" }));

    expect(screen.getByLabelText("Start")).toBeInTheDocument();
    expect(screen.getByLabelText("End")).toBeInTheDocument();
    expect(screen.getByLabelText("Location / URL")).toBeInTheDocument();
  });
});
