import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MeetingActionsBar } from "../../components/meeting/MeetingActionsBar";

vi.mock("../../components/meeting/EnhanceButton", () => ({
  EnhanceButton: () => <button type="button">Enhance Notes</button>,
}));

const baseProps = {
  transcriptDrawerOpen: false,
  onToggleTranscriptDrawer: vi.fn(),
  onStart: vi.fn(),
  meetingId: "meeting-1",
  noteContent: undefined,
  isEnhanced: false,
  onEnhanced: vi.fn(),
  onUndoEnhance: vi.fn(),
  onEnhancingChange: vi.fn(),
  enhanceTriggerRef: { current: null },
  onPause: vi.fn(),
  onResume: vi.fn(),
  onStop: vi.fn(),
};

describe("MeetingActionsBar", () => {
  it("names stable controls in the non-recording toolbar", () => {
    render(<MeetingActionsBar {...baseProps} isRecording={false} isPaused={false} />);

    expect(screen.getByRole("toolbar", { name: "Meeting actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open transcript" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Start recording" })).toBeInTheDocument();
  });

  it("names stable controls in the recording toolbar", () => {
    render(<MeetingActionsBar {...baseProps} isRecording={true} isPaused={false} />);

    expect(screen.getByRole("toolbar", { name: "Recording controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause recording" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  });
});
