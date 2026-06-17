import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveTranscriptView, type LiveSegment } from "../../components/meeting/LiveTranscriptView";

const SEGMENTS: LiveSegment[] = [
  { text: "intro chatter", start_ms: 0, end_ms: 4000, speaker: "Speaker 1" },
  { text: "the budget discussion", start_ms: 5000, end_ms: 9000, speaker: "Speaker 2" },
  { text: "a decision was made", start_ms: 10000, end_ms: 14000, speaker: "Speaker 1" },
];

describe("LiveTranscriptView", () => {
  it("renders the live feed with speaker chips", () => {
    render(<LiveTranscriptView segments={SEGMENTS} />);
    expect(screen.getByText("the budget discussion")).toBeInTheDocument();
    expect(screen.getByText("Speaker 2")).toBeInTheDocument();
  });

  it("shows the waiting state with no segments", () => {
    render(<LiveTranscriptView segments={[]} />);
    expect(screen.getByText(/Transcript will appear here/)).toBeInTheDocument();
  });

  it("no longer hosts the catch-me-up pills — they moved to RecordingAssist (both panes)", () => {
    render(<LiveTranscriptView segments={SEGMENTS} />);
    expect(screen.queryByRole("button", { name: /Catch me up/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ask AI/ })).toBeNull();
  });
});
