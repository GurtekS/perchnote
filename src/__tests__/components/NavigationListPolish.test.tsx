import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingListPanel } from "../../components/layout/MeetingListPanel";
import { CommandPalette } from "../../components/shared/CommandPalette";
import { FolderMeetings } from "../../components/folders/FolderMeetings";
import type { FolderNode, Meeting } from "../../lib/ipc";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

const { navigateMock, matchRouteMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  matchRouteMock: vi.fn(() => false),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useMatchRoute: () => matchRouteMock,
  Link: ({ children, to, params, ...props }: React.PropsWithChildren<{ to: string; params?: Record<string, string> }>) => (
    <a href={params?.id ? `${to.replace("$id", params.id)}` : to} {...props}>
      {children}
    </a>
  ),
}));

function renderWithQuery(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

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
  };
}

function makeFolder(overrides: Partial<FolderNode> = {}): FolderNode {
  return {
    id: "folder-1",
    name: "Projects",
    color: "#5a9c6a",
    icon: "folder",
    sort_order: 0,
    parent_id: null,
    meeting_count: 0,
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    children: [],
    ...overrides,
  };
}

describe("navigation and list polish", () => {
  beforeEach(() => {
    resetTauriCoreMock();
    navigateMock.mockReset();
    matchRouteMock.mockReset();
    matchRouteMock.mockReturnValue(false);
  });

  it("keeps sidebar meeting rows keyboard-openable and selectable", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [makeMeeting()],
        list_folders: () => [],
      },
    });

    renderWithQuery(<MeetingListPanel />);

    const openButton = await screen.findByRole("button", { name: "Open Weekly sync" });
    fireEvent.click(openButton);

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/meeting/$id",
      params: { id: "meeting-1" },
    });

    const selectButton = screen.getByRole("button", { name: "Select Weekly sync" });
    expect(selectButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(selectButton);

    expect(screen.getByText(/1\s+selected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deselect Weekly sync" })).toHaveAttribute("aria-pressed", "true");
  });

  it("filters sidebar meeting rows from the search field", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [
          makeMeeting({ id: "meeting-1", title: "Weekly sync" }),
          makeMeeting({ id: "meeting-2", title: "Customer onboarding retro" }),
        ],
        list_folders: () => [],
      },
    });

    renderWithQuery(<MeetingListPanel />);

    expect(await screen.findByRole("button", { name: "Open Weekly sync" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Customer onboarding retro" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search meetings" }), {
      target: { value: "customer" },
    });

    expect(screen.queryByRole("button", { name: "Open Weekly sync" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Customer onboarding retro" })).toBeInTheDocument();
  });

  it("opens row context menus from the keyboard", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [makeMeeting()],
        list_folders: () => [],
      },
    });

    renderWithQuery(<MeetingListPanel />);

    const openButton = await screen.findByRole("button", { name: "Open Weekly sync" });
    openButton.focus();
    fireEvent.keyDown(openButton, { key: "F10", shiftKey: true });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
  });

  it("exposes command palette result selection state", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [makeMeeting()],
      },
    });

    renderWithQuery(<CommandPalette />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const input = await screen.findByRole("textbox", { name: "Search commands and meetings" });
    const firstOption = await screen.findByRole("option", { name: /New Meeting/ });
    expect(input).toHaveAttribute("aria-controls", "command-palette-results");
    expect(firstOption).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(screen.getByRole("option", { name: /Start Recording/ })).toHaveAttribute("aria-selected", "true");
  });

  it("creates and opens a meeting from the command palette", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [makeMeeting()],
      },
    });

    renderWithQuery(<CommandPalette />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Search commands and meetings" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/meeting/$id",
        params: { id: "mock-meeting" },
      });
    });
  });

  it("shows a folder drop cue while a meeting is dragged over an active folder", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        get_meetings_in_folder: () => [],
        list_folders: () => [],
      },
    });

    renderWithQuery(<FolderMeetings folder={makeFolder()} />);

    document.dispatchEvent(new CustomEvent("meeting-drag-over", { detail: { folderId: "folder-1" } }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Release to move meeting into Projects");
    });
  });
});
