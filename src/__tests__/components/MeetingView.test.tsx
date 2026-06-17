import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingView } from "../../components/meeting/MeetingView";
import { useUIStore } from "../../stores/uiStore";
import type { Meeting, Note } from "../../lib/ipc";

const { ipcMock, mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  ipcMock: {
    getMeeting: vi.fn(),
    getNoteByMeeting: vi.fn(),
    getTranscriptByMeeting: vi.fn(),
    getMeetingTags: vi.fn(),
    getSetting: vi.fn(),
    updateNoteGeneratedContent: vi.fn(),
    updateNoteRawContent: vi.fn(),
    createNote: vi.fn(),
    getOrCreateNote: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/ipc", () => ({
  ipc: ipcMock,
}));

vi.mock("../../components/meeting/MeetingHeader", () => ({
  MeetingHeader: ({ meeting }: { meeting: Meeting }) => <header>{meeting.title}</header>,
}));

vi.mock("../../components/meeting/TranscriptDrawer", () => ({
  TranscriptDrawer: ({ isOpen }: { isOpen: boolean }) => isOpen ? <aside>Transcript drawer</aside> : null,
}));

vi.mock("../../components/meeting/MeetingActionsBar", () => ({
  MeetingActionsBar: ({ onToggleTranscriptDrawer }: { onToggleTranscriptDrawer: () => void }) => (
    <button type="button" onClick={onToggleTranscriptDrawer}>Toggle transcript</button>
  ),
}));

vi.mock("../../components/meeting/NotesSurface", () => ({
  NotesSurface: ({
    isEnhanced,
    notesDisplayMode,
    enhancedContent,
    onUpdate,
    onOriginalUpdate,
  }: {
    isEnhanced: boolean;
    notesDisplayMode: "ai" | "original";
    enhancedContent?: string;
    onUpdate: (json: string) => void;
    onOriginalUpdate: (json: string) => void;
  }) => (
    <section>
      <p>{isEnhanced && notesDisplayMode === "ai" ? "AI notes active" : "Manual notes active"}</p>
      <pre data-testid="enhanced-content">{enhancedContent ?? ""}</pre>
      <button type="button" onClick={() => onUpdate("{\"type\":\"doc\"}")}>Save note</button>
      <button type="button" onClick={() => onOriginalUpdate("{\"type\":\"doc\"}")}>Save original note</button>
    </section>
  ),
}));

vi.mock("../../components/meeting/TagEditor", () => ({
  TagEditor: () => <div>Tags</div>,
}));

vi.mock("../../components/meeting/MetadataStrip", () => ({
  MetadataStrip: () => <div>Meeting details</div>,
}));

vi.mock("../../components/meeting/MeetingStats", () => ({
  MeetingStats: () => <div>Meeting stats</div>,
}));

vi.mock("../../components/meeting/PostRecordingScreen", () => ({
  PostRecordingScreen: () => <div>Post recording</div>,
}));

vi.mock("../../components/meeting/LiveTranscriptView", () => ({
  LiveTranscriptView: () => <div>Live transcript</div>,
}));

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    title: "Design Review",
    scheduled_start: null,
    scheduled_end: null,
    actual_start: null,
    actual_end: null,
    calendar_event_id: null,
    attendees: "[]",
    location: null,
    meeting_url: null,
    platform: "manual",
    status: "complete",
    is_pinned: false,
    is_archived: false,
    deleted_at: null,
    created_at: "2026-05-22T10:00:00.000Z",
    updated_at: "2026-05-22T10:00:00.000Z",
    device_name: null,
    system_audio_captured: false,
    note_status: "draft",
    ...overrides,
  };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    meeting_id: "m1",
    raw_content: "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"}]}",
    generated_content: null,
    template_id: null,
    created_at: "2026-05-22T10:00:00.000Z",
    updated_at: "2026-05-22T10:00:00.000Z",
    ...overrides,
  };
}

function renderMeetingView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MeetingView meetingId="m1" />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

describe("MeetingView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.getState().clearPendingSeek();
    ipcMock.getMeeting.mockResolvedValue(makeMeeting());
    ipcMock.getNoteByMeeting.mockResolvedValue(makeNote());
    ipcMock.getTranscriptByMeeting.mockResolvedValue(null);
    ipcMock.getMeetingTags.mockResolvedValue([]);
    ipcMock.getSetting.mockResolvedValue(null);
    ipcMock.updateNoteGeneratedContent.mockResolvedValue(undefined);
    ipcMock.updateNoteRawContent.mockResolvedValue(undefined);
    ipcMock.createNote.mockResolvedValue(makeNote({ id: "note-created" }));
    ipcMock.getOrCreateNote.mockResolvedValue(makeNote({ id: "note-created" }));
  });

  it("shows a loading state while the meeting query is unresolved", () => {
    ipcMock.getMeeting.mockReturnValue(new Promise(() => {}));

    renderMeetingView();

    expect(screen.getByRole("status")).toHaveTextContent("Loading meeting");
    expect(screen.getByText("Preparing notes, transcript, and meeting details.")).toBeInTheDocument();
  });

  it("shows a not-found state when the meeting is unavailable", async () => {
    ipcMock.getMeeting.mockResolvedValue(null);

    renderMeetingView();

    expect(await screen.findByText("Meeting not found")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Back to Today" })[1]);

    expect(mockNavigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("shows a retryable error state when the meeting query fails", async () => {
    ipcMock.getMeeting.mockRejectedValueOnce(new Error("database offline"));

    renderMeetingView();

    expect(await screen.findByText("Meeting could not be opened")).toBeInTheDocument();
    expect(screen.getByText("database offline")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(ipcMock.getMeeting).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("Design Review")).toBeInTheDocument();
  });

  it("consumes a pending seek parked for this meeting: opens the drawer, seeks, clears the slot", async () => {
    const seeks: number[] = [];
    const onSeek = (e: Event) => seeks.push((e as CustomEvent<{ ms: number }>).detail.ms);
    window.addEventListener("seek-audio", onSeek);
    try {
      useUIStore.getState().setPendingSeek("m1", 754_000);

      renderMeetingView();

      expect(await screen.findByText("Transcript drawer")).toBeInTheDocument();
      // Consumed on mount…
      expect(useUIStore.getState().pendingSeek).toBeNull();
      // …and the buffered dispatch follows once the drawer can hear it.
      await waitFor(() => expect(seeks).toEqual([754_000]));
    } finally {
      window.removeEventListener("seek-audio", onSeek);
    }
  });

  it("ignores a pending seek parked for a different meeting (audit P3-A)", async () => {
    // A seek whose navigation never landed (deleted meeting, failed route)
    // must not pop the drawer or replay in the next meeting opened. The
    // stale entry stays parked — single-slot semantics mean only its own
    // meeting consumes it or the next setPendingSeek overwrites it.
    const seeks: number[] = [];
    const onSeek = (e: Event) => seeks.push((e as CustomEvent<{ ms: number }>).detail.ms);
    window.addEventListener("seek-audio", onSeek);
    try {
      useUIStore.getState().setPendingSeek("m-deleted", 99_000);

      renderMeetingView();

      expect(await screen.findByText("Design Review")).toBeInTheDocument();
      // Outlive the 250ms dispatch window the consume path would have used.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seeks).toEqual([]);
      expect(screen.queryByText("Transcript drawer")).not.toBeInTheDocument();
      expect(useUIStore.getState().pendingSeek).toEqual({ meetingId: "m-deleted", ms: 99_000 });
    } finally {
      window.removeEventListener("seek-audio", onSeek);
      useUIStore.getState().clearPendingSeek();
    }
  });

  it("opens the transcript drawer from the existing document event", async () => {
    renderMeetingView();

    expect(await screen.findByText("Design Review")).toBeInTheDocument();
    expect(screen.queryByText("Transcript drawer")).not.toBeInTheDocument();

    document.dispatchEvent(new CustomEvent("open-transcript-drawer"));

    expect(await screen.findByText("Transcript drawer")).toBeInTheDocument();
  });

  it("keeps AI note edits routed to generated_content", async () => {
    ipcMock.getNoteByMeeting.mockResolvedValue(makeNote({
      generated_content: "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"AI\"}]}]}",
    }));

    renderMeetingView();

    expect(await screen.findByText("AI notes active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(ipcMock.updateNoteGeneratedContent).toHaveBeenCalledWith("note-1", "{\"type\":\"doc\"}");
    });
    expect(ipcMock.updateNoteRawContent).not.toHaveBeenCalledWith("note-1", "{\"type\":\"doc\"}");
  });

  it("picks up external generated_content changes after a note refetch", async () => {
    // e.g. the tasks view toggles an action item: it writes the note in the
    // backend and invalidates ["note", meetingId]; the refetched body must
    // reach the editor, not just the first cached snapshot.
    const unchecked = JSON.stringify({
      type: "doc",
      content: [{ type: "actionItem", attrs: { task: "Ship it", done: false } }],
    });
    const checked = unchecked.replace("\"done\":false", "\"done\":true");
    ipcMock.getNoteByMeeting
      .mockResolvedValueOnce(makeNote({ generated_content: unchecked }))
      .mockResolvedValue(makeNote({ generated_content: checked }));

    const { queryClient } = renderMeetingView();

    expect(await screen.findByText("AI notes active")).toBeInTheDocument();
    expect(screen.getByTestId("enhanced-content").textContent).toContain("\"done\":false");

    queryClient.invalidateQueries({ queryKey: ["note", "m1"] });

    await waitFor(() => {
      expect(screen.getByTestId("enhanced-content").textContent).toContain("\"done\":true");
    });
  });

  it("keeps original-note edits routed to raw_content", async () => {
    renderMeetingView();

    expect(await screen.findByText("Manual notes active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save original note" }));

    await waitFor(() => {
      expect(ipcMock.updateNoteRawContent).toHaveBeenCalledWith("note-1", "{\"type\":\"doc\"}");
    });
  });

  it("creates a note before autosaving when the meeting has no note yet", async () => {
    ipcMock.getNoteByMeeting.mockResolvedValue(null);

    renderMeetingView();

    expect(await screen.findByText("Manual notes active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      // Atomic get-or-create (not a bare create) so concurrent saves can't
      // spawn duplicate note rows.
      expect(ipcMock.getOrCreateNote).toHaveBeenCalledWith("m1");
      expect(ipcMock.updateNoteRawContent).toHaveBeenCalledWith("note-created", "{\"type\":\"doc\"}");
    });
  });
});
