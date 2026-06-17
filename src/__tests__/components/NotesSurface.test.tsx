import { render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { NotesSurface } from "../../components/meeting/NotesSurface";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/ipc", () => ({
  ipc: {
    openLoopsForMeeting: vi.fn().mockResolvedValue([]),
    lastTimeInSeries: vi.fn().mockResolvedValue(null),
    getOrCreateNote: vi.fn().mockResolvedValue({ id: "n1", raw_content: '{"type":"doc","content":[]}' }),
    updateNoteRawContent: vi.fn().mockResolvedValue(undefined),
  },
}));

function render(ui: React.ReactElement) {
  return rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );
}

// Capture the `content` prop handed to whichever NoteEditor is rendered, so we
// can assert which note body the editor is actually initialised with.
vi.mock("../../components/meeting/NoteEditor", () => ({
  NoteEditor: ({ content, placeholder, showToolbar }: { content?: string; placeholder?: string; showToolbar?: boolean }) => (
    <div
      data-testid="editor-content"
      data-placeholder={placeholder ?? ""}
      data-show-toolbar={String(showToolbar)}
    >
      {content ?? ""}
    </div>
  ),
}));
vi.mock("../../components/meeting/EnhancingSkeleton", () => ({
  EnhancingSkeleton: () => <div>skeleton</div>,
}));
vi.mock("../../components/meeting/EnhanceAnimationOverlay", () => ({
  EnhanceAnimationOverlay: () => <div>overlay</div>,
}));
vi.mock("../../components/meeting/AiNotesHeader", () => ({
  AiNotesHeader: () => <div>ai-header</div>,
}));

const RAW = '{"type":"doc","raw":true}';
const AI = '{"type":"doc","ai":true}';

const baseProps = {
  meetingId: "m1",
  editorRef: { current: null },
  noteLoading: false,
  noteRawContent: RAW,
  preEnhanceContent: RAW,
  enhancedContent: AI,
  isEnhanced: true,
  notesDisplayMode: "ai" as const,
  onNotesDisplayModeChange: vi.fn(),
  isEnhancing: false,
  isAnimating: false,
  enhanceAnimText: null,
  onUpdate: vi.fn(),
  onOriginalUpdate: vi.fn(),
  onAnimationComplete: vi.fn(),
};

describe("NotesSurface content routing", () => {
  it("shows the enhanced content (not raw) when enhanced and in AI mode", () => {
    // Regression: reopening an enhanced meeting must restore the AI notes, not
    // silently fall back to the user's original notes.
    render(<NotesSurface {...baseProps} />);
    expect(screen.getByTestId("editor-content").textContent).toBe(AI);
  });

  it("shows the original content when enhanced and in My Notes mode", () => {
    render(<NotesSurface {...baseProps} notesDisplayMode="original" />);
    expect(screen.getByTestId("editor-content").textContent).toBe(RAW);
  });

  it("recording keeps the toolbar (user request) and states the capture contract", () => {
    // The v7 "quiet mode" hid formatting while recording; the user asked
    // for the bar back — recording is exactly when notes get written.
    // showToolbar is no longer forced, so NoteEditor's own default
    // (notepadMode && editable → shown) applies in both states.
    render(
      <NotesSurface {...baseProps} isEnhanced={false} enhancedContent={undefined} isRecording />,
    );
    const editor = screen.getByTestId("editor-content");
    expect(editor.dataset.showToolbar).toBe("undefined"); // mock stringifies the absent prop
    expect(editor.dataset.placeholder).toContain("Jot fragments");
    expect(editor.dataset.placeholder).toContain("Enhance fills in the rest");
  });

  it("not recording: toolbar default, default placeholder", () => {
    render(<NotesSurface {...baseProps} isEnhanced={false} enhancedContent={undefined} />);
    const editor = screen.getByTestId("editor-content");
    expect(editor.dataset.showToolbar).toBe("undefined"); // mock stringifies the absent prop
    expect(editor.dataset.placeholder).toBe("");
  });

  it("shows both raw (My Notes) and enhanced (AI Notes) content in split mode", () => {
    render(<NotesSurface {...baseProps} notesDisplayMode="split" />);
    const contents = screen
      .getAllByTestId("editor-content")
      .map((n) => n.textContent);
    expect(contents).toContain(RAW); // My Notes ← preEnhanceContent / raw_content
    expect(contents).toContain(AI); // AI Notes ← enhancedContent / generated_content
  });

  it("shows raw content when not enhanced", () => {
    render(
      <NotesSurface
        {...baseProps}
        isEnhanced={false}
        enhancedContent={undefined}
      />,
    );
    expect(screen.getByTestId("editor-content").textContent).toBe(RAW);
  });
});

describe("Last time card", () => {
  it("shows the previous meeting's summary and open items before enhancement", async () => {
    const { ipc } = await import("../../lib/ipc");
    vi.mocked(ipc.lastTimeInSeries).mockResolvedValueOnce({
      meeting_id: "prev1",
      title: "Weekly Sync",
      date: "2026-06-02T15:00:00Z",
      summary: "Agreed to ship the beta on Friday.",
      open_items: [
        {
          meeting_id: "prev1", meeting_title: "Weekly Sync", meeting_date: "2026-06-02",
          note_id: "n1", source: "generated" as const, index: 0,
          task: "Send the beta invite list", assignee: null, deadline: null, done: false,
        },
      ],
    });
    render(<NotesSurface {...baseProps} isEnhanced={false} enhancedContent={undefined} />);

    expect(await screen.findByText(/Last time: Weekly Sync/)).toBeInTheDocument();
    expect(screen.getByText("2026-06-02")).toBeInTheDocument();
    expect(screen.getByText("Agreed to ship the beta on Friday.")).toBeInTheDocument();
    expect(screen.getByText("Send the beta invite list")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open last meeting/ })).toBeInTheDocument();
  });

  it("renders no card once the meeting is enhanced", () => {
    render(<NotesSurface {...baseProps} />);
    expect(screen.queryByText(/Last time:/)).not.toBeInTheDocument();
  });

  it("carries open items into this note as a checklist, not actionItems", async () => {
    const { ipc } = await import("../../lib/ipc");
    const { fireEvent, waitFor } = await import("@testing-library/react");
    vi.mocked(ipc.lastTimeInSeries).mockResolvedValueOnce({
      meeting_id: "prev1",
      title: "Weekly Sync",
      date: "2026-06-02T15:00:00Z",
      summary: "",
      open_items: [
        {
          meeting_id: "prev1", meeting_title: "Weekly Sync", meeting_date: "2026-06-02",
          note_id: "n0", source: "generated" as const, index: 0,
          task: "Send the beta invite list", assignee: "Amy", deadline: null, done: false,
        },
      ],
    });
    render(<NotesSurface {...baseProps} isEnhanced={false} enhancedContent={undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: /Carry over 1 open item/ }));
    await waitFor(() => {
      expect(ipc.updateNoteRawContent).toHaveBeenCalledTimes(1);
    });
    const [noteId, json] = vi.mocked(ipc.updateNoteRawContent).mock.calls[0];
    expect(noteId).toBe("n1");
    const doc = JSON.parse(json as string);
    const types = doc.content.map((n: { type: string }) => n.type);
    expect(types).toContain("taskList");
    expect(types).not.toContain("actionItem"); // originals stay the tracked copies
    expect(json).toContain("Send the beta invite list (Amy)");
    expect(json).toContain("From last time (Weekly Sync)");
    expect(await screen.findByText("✓ Added to your notes")).toBeInTheDocument();
  });
});
