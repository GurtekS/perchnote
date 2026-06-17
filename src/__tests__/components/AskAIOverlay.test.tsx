import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AskAIOverlay } from "../../components/meeting/AskAIOverlay";
import { useUIStore } from "../../stores/uiStore";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";
import type { ChatAnswer } from "../../lib/ipc";

const { navigateMock, matchRouteMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  matchRouteMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useMatchRoute: () => matchRouteMock,
}));

// Backend contract (plan v8 A5): citations list every numbered context
// block; the answer text references them as [n] tokens.
const ANSWER: ChatAnswer = {
  answer:
    "Feature X ships in April [1]. Amy reviews the designs [2]. Bogus claim [3].",
  citations: [
    { n: 1, meeting_id: "m1", meeting_title: "Q2 Roadmap", start_ms: 754_000 },
    { n: 2, meeting_id: "m2", meeting_title: "Standup", start_ms: 61_500 },
  ],
};

const MEETING = {
  id: "m1",
  title: "Q2 Roadmap",
  scheduled_start: null,
  scheduled_end: null,
  actual_start: "2026-06-03T12:00:00Z",
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
  created_at: "2026-06-01T12:00:00Z",
  updated_at: "2026-06-01T12:00:00Z",
  device_name: null,
  system_audio_captured: false,
  note_status: "none",
};

const savedMessages: Array<{ role: unknown; content: unknown }> = [];

function renderOverlay(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AskAIOverlay meetingId={null} isOpen onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

async function ask(question = "when does feature x ship?") {
  const input = screen.getByRole("textbox", { name: "Ask across recent meetings" });
  fireEvent.change(input, { target: { value: question } });
  fireEvent.keyDown(input, { key: "Enter" });
  return screen.findByRole("button", { name: "Open source 1: Q2 Roadmap" });
}

describe("AskAIOverlay citation chips", () => {
  beforeEach(() => {
    savedMessages.length = 0;
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [MEETING],
        list_chat_messages: () => [],
        create_chat_message: (args) => {
          savedMessages.push({ role: args?.role, content: args?.content });
          return {
            id: `cm-${savedMessages.length}`,
            meeting_id: null,
            role: args?.role,
            content: args?.content,
            context_meeting_ids: args?.contextMeetingIds ?? "[]",
            created_at: "2026-06-10T00:00:00Z",
          };
        },
        chat_with_meetings: () => ANSWER,
      },
    });
    navigateMock.mockReset();
    navigateMock.mockImplementation(() => Promise.resolve());
    matchRouteMock.mockReset();
    matchRouteMock.mockReturnValue(false);
    useUIStore.getState().clearPendingSeek();
  });

  it("renders matched [n] tokens as chips and leaves hallucinated ones as text", async () => {
    renderOverlay();
    await ask();

    expect(
      screen.getByRole("button", { name: "Open source 2: Standup" }),
    ).toBeInTheDocument();
    // [3] has no backing citation — plain text, no chip.
    expect(screen.queryByRole("button", { name: /source 3/ })).not.toBeInTheDocument();

    const dialog = screen.getByRole("dialog", { name: "Ask AI" });
    expect(dialog.textContent).toContain("Bogus claim [3].");
    // Matched tokens were replaced by chips — the raw token text is gone.
    expect(dialog.textContent).not.toContain("[1]");
    expect(dialog.textContent).not.toContain("[2]");
  });

  it("chip click parks the pending seek, navigates, then dispatches seek-audio", async () => {
    const seeks: number[] = [];
    const onSeek = (e: Event) => seeks.push((e as CustomEvent<{ ms: number }>).detail.ms);
    window.addEventListener("seek-audio", onSeek);
    let seekAtNavigate: { meetingId: string; ms: number } | null = null;
    navigateMock.mockImplementation(() => {
      seekAtNavigate = useUIStore.getState().pendingSeek;
      return Promise.resolve();
    });
    try {
      const onClose = renderOverlay();
      const chip = await ask();

      fireEvent.click(chip);

      // Durable handoff first: the seek is parked (keyed to the cited
      // meeting) before navigation starts…
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/meeting/$id",
        params: { id: "m1" },
      });
      expect(seekAtNavigate).toEqual({ meetingId: "m1", ms: 754_000 });
      // …and the direct dispatch fires once navigation has resolved.
      await waitFor(() => expect(seeks).toEqual([754_000]));
      expect(onClose).toHaveBeenCalled();
    } finally {
      window.removeEventListener("seek-audio", onSeek);
    }
  });

  it("only dispatches seek-audio when already on the cited meeting", async () => {
    const seeks: number[] = [];
    const onSeek = (e: Event) => seeks.push((e as CustomEvent<{ ms: number }>).detail.ms);
    window.addEventListener("seek-audio", onSeek);
    matchRouteMock.mockReturnValue({ id: "m1" });
    try {
      renderOverlay();
      const chip = await ask();

      fireEvent.click(chip);

      await waitFor(() => expect(seeks).toEqual([754_000]));
      expect(navigateMock).not.toHaveBeenCalled();
      expect(useUIStore.getState().pendingSeek).toBeNull();
    } finally {
      window.removeEventListener("seek-audio", onSeek);
    }
  });

  it("persists only the answer text to chat history — citations are session-only", async () => {
    renderOverlay();
    await ask();

    await waitFor(() =>
      expect(savedMessages).toContainEqual({ role: "assistant", content: ANSWER.answer }),
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("AskAIOverlay scope race (audit P3-B)", () => {
  const chatMessageStub = (args?: Record<string, unknown>) => ({
    id: "cm-race",
    meeting_id: null,
    role: args?.role,
    content: args?.content,
    context_meeting_ids: args?.contextMeetingIds ?? "[]",
    created_at: "2026-06-10T00:00:00Z",
  });

  beforeEach(() => {
    navigateMock.mockReset();
    navigateMock.mockImplementation(() => Promise.resolve());
    matchRouteMock.mockReset();
    matchRouteMock.mockReturnValue(false);
  });

  /** Render with a meeting in context so both scope buttons exist; the
   *  returned `ui` lets tests close/reopen the overlay via rerender. */
  function renderWithMeeting() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (open: boolean) => (
      <QueryClientProvider client={qc}>
        <AskAIOverlay meetingId="m1" isOpen={open} onClose={vi.fn()} />
      </QueryClientProvider>
    );
    const view = render(ui(true));
    return { ...view, ui };
  }

  it("locks scope switching while a question is in flight", async () => {
    const d = deferred<string>();
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [MEETING],
        list_chat_messages: () => [],
        create_chat_message: (args) => chatMessageStub(args),
        chat_with_meeting: () => d.promise,
      },
    });
    renderWithMeeting();

    const input = screen.getByRole("textbox", { name: "Ask about this meeting" });
    fireEvent.change(input, { target: { value: "what shipped?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Thinking…");

    const allBtn = screen.getByRole("button", { name: "All meetings" });
    expect(allBtn).toBeDisabled();
    expect(screen.getByRole("button", { name: "This meeting" })).toBeDisabled();
    // A click while disabled is inert — the scope stays put.
    fireEvent.click(allBtn);
    expect(screen.getByRole("button", { name: "This meeting" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await act(async () => {
      d.resolve("Feature X shipped.");
    });
    expect(await screen.findByText("Feature X shipped.")).toBeInTheDocument();
    expect(allBtn).not.toBeDisabled();
  });

  it("drops an orphaned in-flight answer — a late \"all\" response never renders under the \"this\" tab", async () => {
    const d = deferred<ChatAnswer>();
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [MEETING],
        list_chat_messages: () => [],
        create_chat_message: (args) => chatMessageStub(args),
        chat_with_meetings: () => d.promise,
      },
    });
    const { rerender, ui } = renderWithMeeting();

    // Scope A: all meetings (switching is allowed while idle).
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    const input = screen.getByRole("textbox", { name: "Ask across recent meetings" });
    fireEvent.change(input, { target: { value: "when does feature x ship?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Searching recent meetings…");

    // The scope flips back to "this" while the question is still in flight —
    // with the buttons disabled, close/reopen is the path that can still do
    // it (the reset effect re-defaults the scope and orphans the request).
    rerender(ui(false));
    rerender(ui(true));
    expect(screen.getByRole("button", { name: "This meeting" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The old promise resolves late — its answer must not render here.
    await act(async () => {
      d.resolve(ANSWER);
    });
    expect(screen.queryByText(/Feature X ships in April/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open source/ })).not.toBeInTheDocument();
    // Nor may the orphaned request resurrect the loading state.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
