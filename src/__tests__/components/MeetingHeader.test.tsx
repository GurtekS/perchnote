import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MeetingHeader } from "../../components/meeting/MeetingHeader";
import type { Meeting } from "../../lib/ipc";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../../stores/themeStore", () => ({
  useThemeStore: () => "blue",
  folderColorFromId: () => "#888",
}));

const baseMeeting: Meeting = {
  id: "m1",
  title: "Team Standup",
  status: "recording",
  created_at: "2026-03-30T10:00:00Z",
  updated_at: "2026-03-30T10:00:00Z",
  actual_start: "2026-03-30T10:00:00Z",
  actual_end: null,
  scheduled_start: null,
  scheduled_end: null,
  calendar_event_id: null,
  attendees: "[]",
  location: null,
  meeting_url: null,
  platform: "",
  is_pinned: false,
  is_archived: false,
  deleted_at: null,
  device_name: null,
  system_audio_captured: false,
  note_status: "none",
};

describe("MeetingHeader — isRecording variant", () => {
  it("shows pulsing dot and timer when isRecording=true", () => {
    render(
      <MeetingHeader
        meeting={baseMeeting}
        meetingId="m1"
        saveStatus="idle"
        isRecording={true}
        elapsedSeconds={125}
      />
    );
    expect(screen.getByText("02:05")).toBeInTheDocument();
    expect(document.querySelector(".recording-pulse")).toBeInTheDocument();
  });

  it("shows meeting title in recording variant", () => {
    render(
      <MeetingHeader
        meeting={baseMeeting}
        meetingId="m1"
        saveStatus="idle"
        isRecording={true}
        elapsedSeconds={0}
      />
    );
    expect(screen.getByText("Team Standup")).toBeInTheDocument();
  });

  it("hides back button and overflow menu when isRecording=true", () => {
    render(
      <MeetingHeader
        meeting={baseMeeting}
        meetingId="m1"
        saveStatus="idle"
        isRecording={true}
        elapsedSeconds={0}
      />
    );
    expect(screen.queryByTitle("Back to meetings")).not.toBeInTheDocument();
    expect(screen.queryByTitle("More options")).not.toBeInTheDocument();
  });

  it("shows back button and overflow menu when isRecording=false", () => {
    render(
      <MeetingHeader
        meeting={baseMeeting}
        meetingId="m1"
        saveStatus="idle"
        isRecording={false}
        elapsedSeconds={0}
      />
    );
    expect(screen.getByTitle("Back to meetings")).toBeInTheDocument();
    expect(screen.getByTitle("More options")).toBeInTheDocument();
  });
});
