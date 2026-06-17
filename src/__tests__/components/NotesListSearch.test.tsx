import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesList } from "../../components/notes/NotesList";
import type { Meeting, SearchResult } from "../../lib/ipc";
import { invoke, resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  Link: ({ children, to, params, ...props }: React.PropsWithChildren<{ to: string; params?: Record<string, string> }>) => (
    <a href={params?.id ? to.replace("$id", params.id) : to} {...props}>
      {children}
    </a>
  ),
}));

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    title: "Weekly sync",
    scheduled_start: null,
    scheduled_end: null,
    actual_start: "2026-05-22T16:00:00.000Z",
    actual_end: "2026-05-22T16:30:00.000Z",
    calendar_event_id: null,
    attendees: "[]",
    location: null,
    meeting_url: null,
    platform: "manual",
    status: "complete",
    is_pinned: false,
    is_archived: false,
    deleted_at: null,
    created_at: "2026-05-22T16:00:00.000Z",
    updated_at: "2026-05-22T16:30:00.000Z",
    device_name: null,
    system_audio_captured: false,
    note_status: "generated",
    ...overrides,
  } as Meeting;
}

function setupList(searchRows: SearchResult[], meetings: Meeting[]) {
  resetTauriCoreMock({
    commandHandlers: {
      list_meetings: () => meetings,
      list_folders: () => [],
      get_tags_for_meetings: () => ({}),
      list_note_previews: () => [],
      search_with_semantic: () => searchRows,
    },
  });
}

function renderList(initialTag?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotesList initialTag={initialTag} />
    </QueryClientProvider>,
  );
}

async function searchFor(term: string) {
  fireEvent.change(await screen.findByPlaceholderText("Search meetings…"), {
    target: { value: term },
  });
}

describe("NotesList search (server-fused, plan v9 #10)", () => {
  beforeEach(() => {
    localStorage.clear();
    navigateMock.mockReset();
  });

  it("renders keyword and Related rows from the single fused query", async () => {
    setupList(
      [
        // Server-fused payload: search_all arms plus one synthesized
        // "semantic" row for the meeting keyword search missed.
        { meeting_id: "m-kw", match_source: "transcript", snippet: "the budget looks tight", match_start_ms: 3000 },
        { meeting_id: "m-sem", match_source: "semantic", snippet: "how much we can spend", match_start_ms: 61500 },
      ],
      [
        makeMeeting({ id: "m-kw", title: "Budget planning" }),
        makeMeeting({ id: "m-sem", title: "Q3 retro" }),
        makeMeeting({ id: "m-other", title: "Daily standup" }),
      ],
    );

    renderList();
    expect(await screen.findByText("Daily standup")).toBeInTheDocument();

    await searchFor("budget");

    // Semantic-only meeting surfaces as a "Related:" card — its title
    // ("Q3 retro") shares no words with the query, so only the fused
    // payload can have put it here.
    expect(await screen.findByText("Related:", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/how much we can spend/)).toBeInTheDocument();
    expect(screen.getByText("Q3 retro")).toBeInTheDocument();

    // Keyword arm renders as before.
    expect(screen.getByText("Transcript:")).toBeInTheDocument();
    expect(screen.getByText(/the budget looks tight/)).toBeInTheDocument();

    // Meetings absent from the fused payload are filtered out, and the
    // counter counts distinct meetings across all rows.
    expect(screen.queryByText("Daily standup")).not.toBeInTheDocument();
    expect(screen.getByText("2 meetings")).toBeInTheDocument();

    // Semantic rows keep click-to-seek (plan v8 A4): match_start_ms flips
    // the card into its jump-to-moment affordance.
    expect(screen.getByRole("link", { name: "Open Q3 retro" })).toHaveAttribute(
      "title",
      "Open meeting at the matching moment",
    );

    // ONE search round-trip: the old searchAll + semanticSearch pair is gone.
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("search_with_semantic", { query: "budget", limit: 50 });
    });
    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain("search_all");
    expect(commands).not.toContain("semantic_search");
  });

  it("first row per meeting wins the card subline (rows arrive grouped in fused order)", async () => {
    setupList(
      [
        { meeting_id: "m-kw", match_source: "transcript", snippet: "the budget looks tight", match_start_ms: 3000 },
        { meeting_id: "m-kw", match_source: "notes", snippet: "budget follow-ups" },
      ],
      [makeMeeting({ id: "m-kw", title: "Budget planning" })],
    );

    renderList();
    await searchFor("budget");

    expect(await screen.findByText("Transcript:", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/the budget looks tight/)).toBeInTheDocument();
    // The later arm for the same meeting must not produce a second card line.
    expect(screen.queryByText("Notes:")).not.toBeInTheDocument();
    expect(screen.getByText("1 meeting")).toBeInTheDocument();
  });

  // Tags read path (discoverability batch): /meetings?tag= filters by exact
  // tag name, removable via the header chip.
  it("filters by the tag search param and clears it from the header chip", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [
          makeMeeting({ id: "m-tagged", title: "Voice capture" }),
          makeMeeting({ id: "m-plain", title: "Weekly sync" }),
        ],
        list_folders: () => [],
        get_tags_for_meetings: () => ({
          "m-tagged": [{ id: "t1", name: "voice-note", source: "user", created_at: "2026-05-22T00:00:00.000Z" }],
        }),
        list_note_previews: () => [],
      },
    });

    renderList("voice-note");

    expect(await screen.findByText("Voice capture")).toBeInTheDocument();
    expect(screen.queryByText("Weekly sync")).not.toBeInTheDocument();

    const clearChip = screen.getByRole("button", { name: "Stop filtering by tag voice-note" });
    fireEvent.click(clearChip);

    expect(navigateMock).toHaveBeenCalledWith({ to: "/meetings", search: {} });
    // Local state clears immediately — the full list returns.
    expect(await screen.findByText("Weekly sync")).toBeInTheDocument();
  });
});
