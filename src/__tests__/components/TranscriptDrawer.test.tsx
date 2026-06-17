import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptDrawer } from "../../components/meeting/TranscriptDrawer";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getTranscriptByMeeting: vi.fn(),
    listSpeakerLabels: vi.fn(),
    listSpeakerLabelsForMeeting: vi.fn(),
    reclusterSpeakers: vi.fn(),
    upsertSpeakerLabel: vi.fn(),
    updateSegmentText: vi.fn(),
    replaceInTranscript: vi.fn(),
    unknownSpeakersForMeeting: vi.fn(),
    getRecordingUrl: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: vi.fn((path: string) => path),
}));

// jsdom has no layout, so the real virtualizer renders zero rows. Render
// them all instead — these tests assert on content, not windowing.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 44,
      })),
    measureElement: () => {},
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock("../../lib/ipc", () => ({
  ipc: ipcMock,
}));

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TranscriptDrawer meetingId="meeting-1" isOpen onClose={vi.fn()} meetingStatus="complete" />
    </QueryClientProvider>,
  );
}

describe("TranscriptDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMock.getTranscriptByMeeting.mockResolvedValue(null);
    ipcMock.listSpeakerLabels.mockResolvedValue([]);
    ipcMock.listSpeakerLabelsForMeeting.mockResolvedValue([]);
    ipcMock.reclusterSpeakers.mockResolvedValue(2);
    ipcMock.upsertSpeakerLabel.mockResolvedValue(undefined);
    ipcMock.unknownSpeakersForMeeting.mockResolvedValue([]);
    ipcMock.getRecordingUrl.mockResolvedValue(null);
  });

  it("renders a named drawer with labelled transcript search", async () => {
    renderDrawer();

    expect(screen.getByRole("complementary", { name: "Transcript drawer" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search transcript")).toBeInTheDocument();
    expect(await screen.findByText("No transcript")).toBeInTheDocument();
  });

  it("uses pressed state for transcript and speaker tabs", () => {
    renderDrawer();

    const transcriptTab = screen.getByRole("button", { name: "Transcript" });
    const speakersTab = screen.getByRole("button", { name: "Speakers" });
    expect(transcriptTab).toHaveAttribute("aria-pressed", "true");
    expect(speakersTab).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(speakersTab);

    expect(transcriptTab).toHaveAttribute("aria-pressed", "false");
    expect(speakersTab).toHaveAttribute("aria-pressed", "true");
  });

  describe("speaker surfaces consolidated into the Speakers tab", () => {
    const SEGMENTS = JSON.stringify([
      { text: "hello from one", start_ms: 0, end_ms: 4000, speaker: "Speaker 1" },
      { text: "hello from two", start_ms: 5000, end_ms: 9000, speaker: "Speaker 2" },
    ]);

    beforeEach(() => {
      ipcMock.getTranscriptByMeeting.mockResolvedValue({
        id: "t1",
        meeting_id: "meeting-1",
        segments: SEGMENTS,
        source: "test",
        language: "en",
        created_at: "",
      });
      ipcMock.unknownSpeakersForMeeting.mockResolvedValue([
        {
          speaker_key: "Speaker 1",
          display_name: null,
          longest_start_ms: 0,
          longest_end_ms: 4000,
          total_seconds: 4,
          suggested_name: null,
          suggested_similarity: null,
        },
        {
          speaker_key: "Speaker 2",
          display_name: null,
          longest_start_ms: 5000,
          longest_end_ms: 9000,
          total_seconds: 4,
          suggested_name: null,
          suggested_similarity: null,
        },
      ]);
    });

    it("the transcript tab has no separate Speakers disclosure or inline editor", async () => {
      renderDrawer();
      await screen.findByText(/hello from one/);

      // One "Speakers" affordance: the tab. No <details> disclosure.
      expect(document.querySelector("details")).toBeNull();
      // The identify panel (Re-detect) only lives behind the Speakers tab.
      expect(screen.queryByRole("button", { name: /Re-detect/ })).toBeNull();
    });

    it("clicking a speaker pill opens the Speakers tab focused on that speaker", async () => {
      renderDrawer();
      await screen.findByText(/hello from two/);

      fireEvent.click(screen.getByRole("button", { name: "Rename speaker Speaker 2" }));

      expect(screen.getByRole("button", { name: "Speakers" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const input = await screen.findByRole("textbox", { name: "Name for Speaker 2" });
      await waitFor(() => expect(input).toHaveFocus());
      // The single rename surface saves through identifySpeaker — the old
      // bespoke inline editor (upsertSpeakerLabel path) is gone.
      expect(ipcMock.upsertSpeakerLabel).not.toHaveBeenCalled();
    });
  });

  describe("find-in-transcript (plan v9 #11)", () => {
    const SEGMENTS = JSON.stringify([
      { text: "intro chatter before anything", start_ms: 0, end_ms: 4000, speaker: "Speaker 1" },
      { text: "the budget looks tight this quarter", start_ms: 5000, end_ms: 9000, speaker: "Speaker 2" },
      { text: "unrelated middle discussion", start_ms: 10000, end_ms: 14000, speaker: "Speaker 1" },
      { text: "we revisit the budget at the end", start_ms: 15000, end_ms: 19000, speaker: "Speaker 2" },
    ]);

    beforeEach(() => {
      ipcMock.getTranscriptByMeeting.mockResolvedValue({
        id: "t1",
        meeting_id: "meeting-1",
        segments: SEGMENTS,
        source: "test",
        language: "en",
        created_at: "",
      });
    });

    it("find mode keeps context visible, counts matches, and steps with Enter", async () => {
      renderDrawer();
      const input = await screen.findByLabelText("Search transcript");

      fireEvent.change(input, { target: { value: "budget" } });

      // Both matches counted, position shown — and NON-matching context
      // is still rendered (find, not filter).
      expect(await screen.findByTestId("match-count")).toHaveTextContent("1 of 2");
      expect(screen.getByText(/unrelated middle discussion/)).toBeInTheDocument();

      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByTestId("match-count")).toHaveTextContent("2 of 2");
      // Wraps around.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByTestId("match-count")).toHaveTextContent("1 of 2");
      // Shift+Enter goes back (wrapping to the end).
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      expect(screen.getByTestId("match-count")).toHaveTextContent("2 of 2");
    });

    it("the Filter toggle restores hide-non-matching behavior", async () => {
      renderDrawer();
      const input = await screen.findByLabelText("Search transcript");
      fireEvent.change(input, { target: { value: "budget" } });
      await screen.findByTestId("match-count");

      fireEvent.click(screen.getByRole("button", { name: "Filter" }));

      expect(screen.getByTestId("match-count")).toHaveTextContent("2 results");
      expect(screen.queryByText(/unrelated middle discussion/)).toBeNull();
    });

    it("shows No matches without stranding the transcript", async () => {
      renderDrawer();
      const input = await screen.findByLabelText("Search transcript");
      fireEvent.change(input, { target: { value: "zzznothing" } });

      expect(await screen.findByTestId("match-count")).toHaveTextContent("No matches");
      expect(screen.getByText(/intro chatter/)).toBeInTheDocument();
    });
  });

  describe("transcript correction (plan v9 #8)", () => {
    const SEGMENTS = JSON.stringify([
      { text: "jon presented the plan", start_ms: 0, end_ms: 4000, speaker: "Speaker 1" },
      { text: "everyone agreed with jon", start_ms: 5000, end_ms: 9000, speaker: "Speaker 2" },
    ]);

    beforeEach(() => {
      ipcMock.getTranscriptByMeeting.mockResolvedValue({
        id: "t1",
        meeting_id: "meeting-1",
        segments: SEGMENTS,
        source: "test",
        language: "en",
        created_at: "",
      });
      ipcMock.updateSegmentText.mockResolvedValue(true);
      ipcMock.replaceInTranscript.mockResolvedValue(2);
    });

    it("inline edit saves through the ipc and exits edit mode", async () => {
      renderDrawer();
      await screen.findByText(/jon presented the plan/);

      fireEvent.click(screen.getAllByRole("button", { name: "Edit segment text" })[0]);
      const box = screen.getByRole("textbox", { name: "Edit segment text" });
      fireEvent.change(box, { target: { value: "John presented the plan" } });
      fireEvent.keyDown(box, { key: "Enter" });

      await waitFor(() =>
        expect(ipcMock.updateSegmentText).toHaveBeenCalledWith(
          "meeting-1",
          0,
          "John presented the plan",
        ),
      );
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: "Edit segment text" })).toBeNull(),
      );
    });

    it("replace-all rides the find query", async () => {
      renderDrawer();
      const input = await screen.findByLabelText("Search transcript");
      fireEvent.change(input, { target: { value: "jon" } });
      await screen.findByTestId("match-count");

      const replaceBox = screen.getByLabelText("Replacement text");
      fireEvent.change(replaceBox, { target: { value: "John" } });
      fireEvent.click(screen.getByRole("button", { name: "Replace all" }));

      await waitFor(() =>
        expect(ipcMock.replaceInTranscript).toHaveBeenCalledWith("meeting-1", "jon", "John"),
      );
    });

    it("escape cancels an edit without saving", async () => {
      renderDrawer();
      await screen.findByText(/jon presented the plan/);

      fireEvent.click(screen.getAllByRole("button", { name: "Edit segment text" })[0]);
      const box = screen.getByRole("textbox", { name: "Edit segment text" });
      fireEvent.change(box, { target: { value: "scrapped" } });
      fireEvent.keyDown(box, { key: "Escape" });

      expect(screen.queryByRole("textbox", { name: "Edit segment text" })).toBeNull();
      expect(ipcMock.updateSegmentText).not.toHaveBeenCalled();
    });
  });
});
