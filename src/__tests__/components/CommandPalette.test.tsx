import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../../components/shared/CommandPalette";
import { useUIStore } from "../../stores/uiStore";
import type { Meeting, SearchResult } from "../../lib/ipc";

const { ipcMock, navigateMock, matchRouteMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  matchRouteMock: vi.fn(),
  ipcMock: {
    listMeetings: vi.fn(),
    searchAll: vi.fn(),
    createMeeting: vi.fn(),
    listTags: vi.fn(),
    createTag: vi.fn(),
    addTagToMeeting: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useMatchRoute: () => matchRouteMock,
}));
vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));

function meeting(over: Partial<Meeting> & Pick<Meeting, "id" | "title">): Meeting {
  return {
    scheduled_start: null,
    scheduled_end: null,
    actual_start: null,
    actual_end: null,
    calendar_event_id: null,
    attendees: "[]",
    location: null,
    meeting_url: null,
    platform: "manual",
    status: "completed",
    is_pinned: false,
    is_archived: false,
    deleted_at: null,
    created_at: "2026-06-01T12:00:00Z",
    updated_at: "2026-06-01T12:00:00Z",
    device_name: null,
    system_audio_captured: false,
    note_status: "none",
    ...over,
  };
}

const MEETINGS: Meeting[] = [
  meeting({ id: "m1", title: "Q2 Roadmap", actual_start: "2026-06-03T12:00:00Z" }),
  meeting({ id: "m2", title: "Standup", actual_start: "2026-06-05T12:00:00Z" }),
];

// Backend contract (plan v8 A1): at most one hit per meeting per arm;
// transcript hits carry the best segment's start for jump-to-moment.
const RESULTS: SearchResult[] = [
  { meeting_id: "m1", match_source: "title", snippet: "Q2 Roadmap" },
  {
    meeting_id: "m1",
    match_source: "transcript",
    snippet: "the roadmap ships in April",
    match_start_ms: 754_000,
  },
  { meeting_id: "m2", match_source: "notes", snippet: "roadmap follow-ups for Amy" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderPalette() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CommandPalette />
    </QueryClientProvider>,
  );
}

async function openPalette() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  return screen.findByRole("textbox", { name: "Search commands and meetings" });
}

async function openAndSearch(query = "roadmap") {
  const input = await openPalette();
  fireEvent.change(input, { target: { value: query } });
  return input;
}

describe("CommandPalette grouped search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    matchRouteMock.mockReturnValue(false);
    navigateMock.mockImplementation(() => Promise.resolve());
    ipcMock.listMeetings.mockResolvedValue(MEETINGS);
    ipcMock.searchAll.mockResolvedValue(RESULTS);
    useUIStore.getState().clearPendingSeek();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the zero-state Actions/Meetings lists without calling searchAll", async () => {
    renderPalette();
    await openPalette();

    expect(await screen.findByText("Q2 Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(ipcMock.searchAll).not.toHaveBeenCalled();
  });

  it("keeps the instant title filter visible while full search loads, then swaps in groups", async () => {
    const d = deferred<SearchResult[]>();
    ipcMock.searchAll.mockReturnValue(d.promise);
    renderPalette();
    await openPalette();
    await screen.findByText("Q2 Roadmap"); // meetings cache loaded
    fireEvent.change(screen.getByRole("textbox", { name: "Search commands and meetings" }), {
      target: { value: "roadmap" },
    });

    // Fallback: client-side title filter, still under the legacy heading.
    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();

    await waitFor(() => expect(ipcMock.searchAll).toHaveBeenCalledWith("roadmap", 30));
    // Response not resolved yet — fallback must still be there.
    expect(screen.getByText("Meetings")).toBeInTheDocument();

    d.resolve(RESULTS);
    expect(await screen.findByText("[12:34] the roadmap ships in April")).toBeInTheDocument();
    expect(screen.queryByText("Meetings")).not.toBeInTheDocument();
  });

  it("groups results by meeting: two sources, same meeting → one group with two rows", async () => {
    renderPalette();
    await openAndSearch();

    await screen.findByText("[12:34] the roadmap ships in April");

    const roadmapGroups = screen.getAllByRole("group", { name: /Q2 Roadmap/ });
    expect(roadmapGroups).toHaveLength(1);
    expect(within(roadmapGroups[0]).getAllByRole("option")).toHaveLength(2);
    // Header carries the date from the cached meeting.
    expect(roadmapGroups[0].getAttribute("aria-label")).toMatch(/·/);

    const standupGroup = screen.getByRole("group", { name: /Standup/ });
    const noteRows = within(standupGroup).getAllByRole("option");
    expect(noteRows).toHaveLength(1);
    expect(within(noteRows[0]).getByText("roadmap follow-ups for Amy")).toBeInTheDocument();
    expect(within(noteRows[0]).getByText("note")).toBeInTheDocument();
  });

  it("Enter on a transcript row navigates, parks the pending seek, and dispatches seek-audio", async () => {
    const seeks: number[] = [];
    const onSeek = (e: Event) => seeks.push((e as CustomEvent<{ ms: number }>).detail.ms);
    window.addEventListener("seek-audio", onSeek);
    try {
      renderPalette();
      const input = await openAndSearch();
      await screen.findByText("[12:34] the roadmap ships in April");

      // Rows: [m1 title, m1 transcript, m2 note] — no action matches "roadmap".
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });

      // Durable handoff for the async-mounting MeetingView — keyed to the
      // target meeting so it can't replay anywhere else.
      expect(useUIStore.getState().pendingSeek).toEqual({ meetingId: "m1", ms: 754_000 });
      expect(navigateMock).toHaveBeenCalledWith({ to: "/meeting/$id", params: { id: "m1" } });
      // …and the direct dispatch once navigation has resolved.
      await waitFor(() => expect(seeks).toEqual([754_000]));
      // Palette closes on selection.
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("seek-audio", onSeek);
    }
  });

  it("Enter on a note row just opens the meeting — no seek", async () => {
    const seeks: number[] = [];
    const onSeek = (e: Event) => seeks.push((e as CustomEvent<{ ms: number }>).detail.ms);
    window.addEventListener("seek-audio", onSeek);
    try {
      renderPalette();
      const input = await openAndSearch();
      await screen.findByText("[12:34] the roadmap ships in April");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(navigateMock).toHaveBeenCalledWith({ to: "/meeting/$id", params: { id: "m2" } });
      expect(useUIStore.getState().pendingSeek).toBeNull();
      await act(async () => {});
      expect(seeks).toEqual([]);
    } finally {
      window.removeEventListener("seek-audio", onSeek);
    }
  });

  it("keyboard traversal walks the flattened rows across group boundaries", async () => {
    renderPalette();
    const input = await openAndSearch();
    await screen.findByText("[12:34] the roadmap ships in April");

    expect(input).toHaveAttribute("aria-activedescendant", "command-palette-search-m1-title");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "command-palette-search-m1-transcript",
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "command-palette-search-m2-notes");
    const noteRow = document.getElementById("command-palette-search-m2-notes");
    expect(noteRow).toHaveAttribute("aria-selected", "true");

    // Clamped at the end; ArrowUp walks back across the boundary.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "command-palette-search-m2-notes");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "command-palette-search-m1-transcript",
    );
  });

  it("debounces searchAll (~200ms) and skips queries under 2 chars", async () => {
    vi.useFakeTimers();
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByRole("textbox", { name: "Search commands and meetings" });

    fireEvent.change(input, { target: { value: "r" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(ipcMock.searchAll).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "ro" } });
    fireEvent.change(input, { target: { value: "roadmap" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(ipcMock.searchAll).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(ipcMock.searchAll).toHaveBeenCalledTimes(1);
    expect(ipcMock.searchAll).toHaveBeenCalledWith("roadmap", 30);
  });

  it("a pending deep-link query opens the palette pre-filled and consumes the store value", async () => {
    renderPalette();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();

    act(() => {
      useUIStore.getState().setPendingPaletteQuery("roadmap");
    });

    const input = await screen.findByRole("textbox", { name: "Search commands and meetings" });
    expect(input).toHaveValue("roadmap");
    expect(useUIStore.getState().pendingPaletteQuery).toBeNull();
    // Pre-fill behaves exactly like typing: the debounced full search runs.
    await waitFor(() => expect(ipcMock.searchAll).toHaveBeenCalledWith("roadmap", 30));
    expect(await screen.findByText("[12:34] the roadmap ships in April")).toBeInTheDocument();
  });

  it("shows Searching… while in flight with no fallback rows, then No results found", async () => {
    const d = deferred<SearchResult[]>();
    ipcMock.searchAll.mockReturnValue(d.promise);
    renderPalette();
    await openAndSearch("zzzz");

    expect(screen.getByRole("status")).toHaveTextContent("Searching…");

    await waitFor(() => expect(ipcMock.searchAll).toHaveBeenCalledWith("zzzz", 30));
    d.resolve([]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No results found"));
  });

  it("renders filter chips for grammar tokens, flagging malformed dates (A3 chips)", async () => {
    renderPalette();
    await openAndSearch("speaker:amy before:junk budget");

    const chips = screen.getByTestId("filter-chips");
    expect(within(chips).getByText(/speaker:/)).toBeInTheDocument();
    expect(chips).toHaveTextContent("amy");
    expect(chips).toHaveTextContent("ignored"); // before:junk is dropped by the backend
    // Footer swaps to the grammar hint while a search is active.
    expect(screen.getByText(/before:\/after:YYYY-MM-DD/)).toBeInTheDocument();

    // Plain queries show no chips row.
    const input = screen.getByRole("textbox", { name: "Search commands and meetings" });
    fireEvent.change(input, { target: { value: "budget" } });
    await waitFor(() => expect(screen.queryByTestId("filter-chips")).toBeNull());
  });

  it("offers an All meetings action that opens the /meetings browser", async () => {
    renderPalette();
    await openPalette();

    fireEvent.click(await screen.findByRole("option", { name: /All meetings/ }));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/meetings" });
  });

  it("Quick Voice Note creates the tagged meeting, arms auto-start, and navigates", async () => {
    ipcMock.createMeeting.mockResolvedValue(meeting({ id: "m-voice", title: "Voice note x" }));
    ipcMock.listTags.mockResolvedValue([]);
    ipcMock.createTag.mockResolvedValue({ id: "t1", name: "voice-note" });
    ipcMock.addTagToMeeting.mockResolvedValue(undefined);
    renderPalette();
    await openPalette();

    fireEvent.click(await screen.findByRole("option", { name: /Quick Voice Note/ }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ to: "/meeting/$id", params: { id: "m-voice" } }),
    );
    expect(ipcMock.createMeeting.mock.calls[0][0]).toMatch(/^Voice note /);
    expect(ipcMock.addTagToMeeting).toHaveBeenCalledWith("m-voice", "t1");
    expect(useUIStore.getState().pendingAutoStart).toBe("m-voice");
    useUIStore.getState().setPendingAutoStart(null);
  });

  it("hides the Recipes row off meeting pages", async () => {
    renderPalette();
    await openPalette();
    expect(screen.queryByRole("option", { name: /Recipes/ })).not.toBeInTheDocument();
  });
});
