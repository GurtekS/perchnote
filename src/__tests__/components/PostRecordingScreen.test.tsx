import { render, screen, act, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PostRecordingScreen } from "../../components/meeting/PostRecordingScreen";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: vi.fn((p: string) => p),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

function withQuery(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("PostRecordingScreen", () => {
  const defaultProps = {
    meetingId: "test-meeting-id",
    duration: 2520,        // 42 min
    segmentCount: 847,
    speakerCount: 3,
    onEnhance: vi.fn(),
    onReviewTranscript: vi.fn(),
    onDismiss: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    defaultProps.onEnhance.mockClear();
    defaultProps.onReviewTranscript.mockClear();
    defaultProps.onDismiss.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("shows formatted duration", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} />));
    expect(screen.getByText(/42 min/)).toBeInTheDocument();
  });

  it("shows segment count", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} />));
    expect(screen.getByText("847")).toBeInTheDocument();
    expect(screen.getByText("Transcript segments")).toBeInTheDocument();
  });

  it("shows speaker count when provided", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} />));
    expect(screen.getByText("Speakers detected")).toBeInTheDocument();
  });

  it("shows a no-speakers placeholder when speakerCount is null", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} speakerCount={null} />));
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("shows a no-speakers placeholder when speakerCount is 0", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} speakerCount={0} />));
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("calls onEnhance when Enhance Notes clicked", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} />));
    fireEvent.click(screen.getByText(/Enhance Notes/));
    expect(defaultProps.onEnhance).toHaveBeenCalledOnce();
  });

  it("calls onReviewTranscript when Review Transcript clicked", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} />));
    fireEvent.click(screen.getByText("Review Transcript"));
    expect(defaultProps.onReviewTranscript).toHaveBeenCalledOnce();
  });

  it("calls onDismiss when Back to notes clicked", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} />));
    fireEvent.click(screen.getByText("Back to notes"));
    expect(defaultProps.onDismiss).toHaveBeenCalledOnce();
  });

  it("auto-dismisses after 20 seconds", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} />));
    act(() => vi.advanceTimersByTime(20000));
    expect(defaultProps.onDismiss).toHaveBeenCalledOnce();
  });

  it("shows < 1 min for sub-60s duration", () => {
    render(withQuery(<PostRecordingScreen {...defaultProps} duration={30} />));
    expect(screen.getByText(/< 1 min/)).toBeInTheDocument();
  });
});
