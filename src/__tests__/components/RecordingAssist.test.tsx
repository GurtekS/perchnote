import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordingAssist } from "../../components/meeting/RecordingAssist";

// The pills moved out of LiveTranscriptView (discoverability batch):
// MeetingView renders RecordingAssist over BOTH recording panes, so
// catch-me-up exists in the default Notes view too — not just behind the
// Live Transcript tab flip.
describe("RecordingAssist catch-me-up (plan v9 #5)", () => {
  it("renders nothing without the catchMeUp prop (AI unconfigured)", () => {
    render(<RecordingAssist segmentCount={5} />);
    expect(screen.queryByRole("button", { name: /Catch me up/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ask AI/ })).toBeNull();
  });

  it("requests a recap and shows the transient card, dismissible", async () => {
    const catchMeUp = vi.fn().mockResolvedValue("- budget discussed\n- decision made");
    render(<RecordingAssist segmentCount={5} catchMeUp={catchMeUp} />);

    expect(screen.getByRole("button", { name: /Ask AI/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Catch me up/ }));
    expect(catchMeUp).toHaveBeenCalledTimes(1);

    const card = await screen.findByRole("region", { name: "Catch-up recap" });
    expect(card).toHaveTextContent("budget discussed");
    expect(card).toHaveTextContent("Not saved anywhere");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss recap" }));
    expect(screen.queryByRole("region", { name: "Catch-up recap" })).toBeNull();
  });

  it("shows the error in the card", async () => {
    const catchMeUp = vi.fn().mockRejectedValue("Nothing transcribed yet — give it a moment");
    render(<RecordingAssist segmentCount={5} catchMeUp={catchMeUp} />);

    fireEvent.click(screen.getByRole("button", { name: /Catch me up/ }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Catch-up recap" })).toHaveTextContent(
        "Nothing transcribed yet",
      ),
    );
  });

  it("needs a few segments before offering the buttons", () => {
    const catchMeUp = vi.fn();
    render(<RecordingAssist segmentCount={2} catchMeUp={catchMeUp} />);
    expect(screen.queryByRole("button", { name: /Catch me up/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ask AI/ })).toBeNull();
  });
});
