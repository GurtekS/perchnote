import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../../components/home/TodayView";
import type { Meeting } from "../../lib/ipc";
import { useToastStore } from "../../stores/toastStore";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const mockInvoke = vi.mocked(invoke);

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    title: "Planning sync",
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
    created_at: "2020-01-01T09:00:00.000Z",
    updated_at: "2020-01-01T10:00:00.000Z",
    device_name: null,
    system_audio_captured: false,
    note_status: "none",
    ...overrides,
  };
}

function renderToday(meetings: Meeting[]) {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === "list_meetings") return meetings;
    if (command === "create_meeting") return makeMeeting({ id: "new-meeting" });
    return null;
  });

  return renderTodayComponent();
}

function renderTodayComponent() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TodayView />
    </QueryClientProvider>,
  );
}

describe("TodayView", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    navigateMock.mockReset();
    useToastStore.setState({ toasts: [] });
  });

  it("shows a first-empty-account cue with concrete recording and setup actions", async () => {
    renderToday([]);

    expect(await screen.findByText("Start your first meeting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start first recording/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Record a meeting now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open setup guide/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Record now without connecting calendar or AI/i),
    ).toBeInTheDocument();
  });

  it("keeps the regular today empty state when older meetings exist", async () => {
    renderToday([
      makeMeeting({
        actual_start: "2020-01-01T09:00:00.000Z",
        actual_end: "2020-01-01T09:30:00.000Z",
      }),
    ]);

    expect(await screen.findByText("No meetings scheduled today")).toBeInTheDocument();
    expect(screen.queryByText("Start your first meeting")).not.toBeInTheDocument();
  });

  it("starts a new meeting from the first recording CTA", async () => {
    renderToday([]);

    fireEvent.click(await screen.findByRole("button", { name: /Start first recording/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_meeting", {
        title: expect.stringMatching(/^Meeting/),
      });
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/meeting/$id",
      params: { id: "new-meeting" },
    });
  });

  it("opens the setup guide from the first-empty-account cue", async () => {
    renderToday([]);

    fireEvent.click(await screen.findByRole("button", { name: /Open setup guide/i }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "setup" },
    });
  });

  it("shows busy feedback while a new meeting is being created", async () => {
    let resolveCreateMeeting: (meeting: Meeting) => void = () => {};
    mockInvoke.mockImplementation((command: string) => {
      if (command === "list_meetings") return Promise.resolve([]);
      if (command === "create_meeting") {
        return new Promise<Meeting>((resolve) => {
          resolveCreateMeeting = resolve;
        });
      }
      return Promise.resolve(null);
    });
    renderTodayComponent();

    fireEvent.click(await screen.findByRole("button", { name: /Start first recording/i }));

    const busyButton = (await screen.findAllByRole("button", { name: /Creating first meeting/i }))[0];
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");

    resolveCreateMeeting(makeMeeting({ id: "new-meeting" }));
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/meeting/$id",
        params: { id: "new-meeting" },
      });
    });
  });

  it("reports meeting creation failures without navigating away", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "list_meetings") return [];
      if (command === "create_meeting") throw new Error("database locked");
      return null;
    });
    renderTodayComponent();

    fireEvent.click(await screen.findByRole("button", { name: /Start first recording/i }));

    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.message).toContain(
        "Could not create a meeting: Error: database locked",
      );
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Start first recording/i })).not.toBeDisabled();
  });
});
