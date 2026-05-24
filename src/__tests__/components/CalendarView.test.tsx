import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarView } from "../../components/calendar/CalendarView";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";
import { useToastStore } from "../../stores/toastStore";
import type { Meeting } from "../../lib/ipc";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

function renderCalendar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CalendarView />
    </QueryClientProvider>,
  );
}

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "calendar-meeting-1",
    title: "Design review",
    scheduled_start: null,
    scheduled_end: null,
    actual_start: null,
    actual_end: null,
    calendar_event_id: "event-1",
    attendees: "[]",
    location: null,
    meeting_url: null,
    platform: "manual",
    status: "scheduled",
    is_pinned: false,
    is_archived: false,
    deleted_at: null,
    created_at: "2026-05-22T08:00:00.000Z",
    updated_at: "2026-05-22T08:00:00.000Z",
    device_name: null,
    system_audio_captured: false,
    note_status: "none",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe("CalendarView", () => {
  beforeEach(() => {
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [],
      },
    });
    navigateMock.mockReset();
    useToastStore.setState({ toasts: [] });
  });

  it("labels compact toolbar controls and exposes active view state", async () => {
    renderCalendar();

    expect(await screen.findByRole("button", { name: "Sync calendar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous period" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next period" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));

    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Agenda" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows one actionable empty state across disconnected calendar views", async () => {
    renderCalendar();

    expect(await screen.findByText("Connect a calendar to fill this view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Calendar settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for calendar events" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByText("Connect a calendar to fill this view")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));
    expect(await screen.findByText("Connect a calendar to fill this view")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Calendar settings" }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "calendar" },
    });
  });

  it("distinguishes connected calendar views with no visible meetings", async () => {
    resetTauriCoreMock({
      googleConnected: true,
      commandHandlers: {
        list_meetings: () => [],
      },
    });

    renderCalendar();

    expect(await screen.findByText("No calendar meetings this week")).toBeInTheDocument();
    expect(screen.getByText("Calendar connected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByText("No calendar meetings this month")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));
    expect(await screen.findByText("No calendar meetings this agenda range")).toBeInTheDocument();
  });

  it("keeps the empty state actionable while calendar status is still loading", async () => {
    const googleConnected = deferred<boolean>();
    resetTauriCoreMock({
      commandHandlers: {
        is_calendar_connected: () => googleConnected.promise,
        list_meetings: () => [],
      },
    });

    renderCalendar();

    expect(await screen.findByText("Checking calendar setup")).toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for calendar events" })).toBeDisabled();

    googleConnected.resolve(false);
  });

  it("surfaces calendar status failures with stable recovery actions", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        is_calendar_connected: () => {
          throw new Error("keychain unavailable");
        },
        list_meetings: () => [],
      },
    });

    renderCalendar();

    expect(await screen.findByRole("alert")).toHaveTextContent("Calendar status could not be checked");
    expect(screen.getByText("Status issue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Calendar settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for calendar events" })).not.toBeDisabled();
  });

  it("renders a readable compact week list with explicit record actions", async () => {
    const start = new Date();
    start.setHours(9, 0, 0, 0);
    const end = new Date(start);
    end.setHours(10, 0, 0, 0);
    resetTauriCoreMock({
      googleConnected: true,
      commandHandlers: {
        list_meetings: () => [
          makeMeeting({
            scheduled_start: start.toISOString(),
            scheduled_end: end.toISOString(),
          }),
        ],
      },
    });

    renderCalendar();

    expect((await screen.findAllByText("Design review")).length).toBeGreaterThan(0);
    expect(screen.getByText("1 meeting")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/meeting/$id",
      params: { id: "calendar-meeting-1" },
    });
  });

  it("shows sync busy state and reports sync failures", async () => {
    let rejectSync: (reason?: unknown) => void = () => {};
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [],
        sync_ics_calendars: () =>
          new Promise((_, reject) => {
            rejectSync = reject;
          }),
      },
    });

    renderCalendar();
    fireEvent.click(await screen.findByRole("button", { name: "Sync calendar" }));

    const syncingButton = await screen.findByRole("button", { name: "Syncing calendar" });
    expect(syncingButton).toBeDisabled();
    expect(syncingButton).toHaveAttribute("aria-busy", "true");

    rejectSync(new Error("offline"));

    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.message).toContain(
        "Calendar sync failed: Error: offline",
      );
    });
    expect(screen.getByText("Calendar sync failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync calendar" })).not.toBeDisabled();
  });
});
