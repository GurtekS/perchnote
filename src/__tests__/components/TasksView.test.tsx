import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TasksView } from "../../components/tasks/TasksView";
import type { ActionItem } from "../../lib/ipc";

const { ipcMock, mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  ipcMock: {
    listActionItems: vi.fn(),
    listMeetings: vi.fn(),
    setActionItemDone: vi.fn(),
    exportTasksToReminders: vi.fn(),
    openUrl: vi.fn(),
    setTaskSnooze: vi.fn(),
    setTaskDropped: vi.fn(),
    pullReminderCompletions: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mockNavigate }));
vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("../../stores/toastStore", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../lib/mirrorLifecycle", () => ({ scheduleMirror: vi.fn() }));

import { toast } from "../../stores/toastStore";
import { scheduleMirror } from "../../lib/mirrorLifecycle";

function item(over: Partial<ActionItem>): ActionItem {
  return {
    meeting_id: "m1",
    meeting_title: "Standup",
    meeting_date: "2026-06-01T10:00:00Z",
    note_id: "n1",
    source: "generated",
    index: 0,
    task: "Task",
    assignee: null,
    deadline: null,
    done: false,
    ...over,
  };
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <TasksView />
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

describe("TasksView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMock.listMeetings.mockResolvedValue([]);
    ipcMock.setActionItemDone.mockResolvedValue(undefined);
    ipcMock.setTaskSnooze.mockResolvedValue(undefined);
    ipcMock.setTaskDropped.mockResolvedValue(undefined);
    ipcMock.pullReminderCompletions.mockResolvedValue(0);
  });

  it("hides done tasks by default (Open filter) and shows them under All", async () => {
    ipcMock.listActionItems.mockResolvedValue([
      item({ index: 0, task: "Open task" }),
      item({ index: 1, task: "Done task", done: true }),
    ]);

    renderView();

    expect(await screen.findByText("Open task")).toBeInTheDocument();
    expect(screen.queryByText("Done task")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(await screen.findByText("Done task")).toBeInTheDocument();
  });

  it("toggling a task calls setActionItemDone with its address", async () => {
    ipcMock.listActionItems.mockResolvedValue([
      item({ note_id: "n9", source: "generated", index: 2, task: "Ship it", done: false }),
    ]);

    renderView();
    await screen.findByText("Ship it");

    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));

    await waitFor(() => {
      expect(ipcMock.setActionItemDone).toHaveBeenCalledWith("n9", "generated", 2, true, expect.any(String));
    });
  });

  it("filters by assignee", async () => {
    ipcMock.listActionItems.mockResolvedValue([
      item({ index: 0, task: "Amy task", assignee: "Amy" }),
      item({ index: 1, task: "Sam task", assignee: "Sam" }),
    ]);

    renderView();
    await screen.findByText("Amy task");

    fireEvent.change(screen.getByLabelText("Filter by assignee"), { target: { value: "Amy" } });

    expect(screen.getByText("Amy task")).toBeInTheDocument();
    expect(screen.queryByText("Sam task")).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no action items", async () => {
    ipcMock.listActionItems.mockResolvedValue([]);
    renderView();
    expect(await screen.findByText("No tasks yet")).toBeInTheDocument();
  });

  it("exports the visible open tasks to Reminders with mapped fields", async () => {
    ipcMock.listActionItems.mockResolvedValue([
      item({ task: "Send recap", deadline: "2026-06-12", assignee: "Amy", done: false, meeting_title: "Weekly sync" }),
      item({ task: "Done already", done: true, index: 1 }),
    ]);
    ipcMock.exportTasksToReminders.mockResolvedValue(1);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TasksView />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Send recap")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send to…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Apple Reminders/ }));

    await waitFor(() => {
      expect(ipcMock.exportTasksToReminders).toHaveBeenCalledTimes(1);
    });
    const items = ipcMock.exportTasksToReminders.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0].task).toBe("Send recap");
    expect(items[0].deadline).toBe("2026-06-12");
    expect(items[0].body).toContain("Weekly sync");
    expect(items[0].body).toContain("Amy");
  });

  it("sends visible open tasks to Things in one json URL and states the one-way asymmetry", async () => {
    ipcMock.listActionItems.mockResolvedValue([
      item({ task: "Send recap", deadline: "2026-06-12", meeting_id: "m-77", meeting_title: "Weekly sync" }),
      item({ task: "Done already", done: true, index: 1 }),
    ]);
    ipcMock.openUrl.mockResolvedValue(undefined);

    renderView();
    expect(await screen.findByText("Send recap")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send to…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Things/ }));

    await waitFor(() => {
      expect(ipcMock.openUrl).toHaveBeenCalledTimes(1);
    });
    const url: string = ipcMock.openUrl.mock.calls[0][0];
    expect(url.startsWith("things:///json?data=")).toBe(true);
    const payload = JSON.parse(decodeURIComponent(url.slice("things:///json?data=".length)));
    expect(payload).toHaveLength(1); // done task excluded
    expect(payload[0].type).toBe("to-do");
    expect(payload[0].attributes.title).toBe("Send recap");
    expect(payload[0].attributes.deadline).toBe("2026-06-12");
    expect(payload[0].attributes.notes).toContain("Weekly sync");
    expect(payload[0].attributes.notes).toContain("perchnote://meeting/m-77");

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("won't sync back"),
    );
  });

  it("disables Things in the Send-to menu when there are no visible open tasks", async () => {
    ipcMock.listActionItems.mockResolvedValue([
      item({ task: "Done task", done: true }),
    ]);

    renderView();
    // Default Open lens: the done task is filtered out, nothing is sendable.
    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send to…" }));
    expect(screen.getByRole("menuitem", { name: /^Things/ })).toBeDisabled();
    // The Reminders item stays enabled (it has its own empty-set toast).
    expect(screen.getByRole("menuitem", { name: /Apple Reminders/ })).toBeEnabled();
  });

  describe("review surfaces are mutually exclusive (UX audit)", () => {
    // A meeting a month old makes the task stale (>= 2 weeks).
    const staleDate = () => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    };

    /** The week review card auto-opens on Mondays — start from closed. */
    const closeWeekReviewIfOpen = () => {
      const toggle = screen.getByRole("button", { name: "Week review" });
      if (toggle.getAttribute("aria-pressed") === "true") fireEvent.click(toggle);
    };

    const weekCard = () => screen.queryByText("Week in review");
    const staleBanner = () => screen.queryByText(/from meetings over two/);
    const triagePanel = () => screen.queryByText(/Review stale items/);

    it("shows at most one of: week review card, stale banner, triage panel", async () => {
      ipcMock.listActionItems.mockResolvedValue([
        item({ task: "Mouldy task", meeting_date: staleDate() }),
      ]);
      renderView();
      await screen.findByText("Mouldy task");
      closeWeekReviewIfOpen();

      // Stale banner alone.
      expect(staleBanner()).toBeInTheDocument();
      expect(weekCard()).toBeNull();
      expect(triagePanel()).toBeNull();

      // Opening the week review collapses the banner.
      fireEvent.click(screen.getByRole("button", { name: "Week review" }));
      expect(weekCard()).toBeInTheDocument();
      expect(staleBanner()).toBeNull();
      expect(triagePanel()).toBeNull();

      // Closing it brings the banner back.
      fireEvent.click(screen.getByRole("button", { name: "Week review" }));
      expect(staleBanner()).toBeInTheDocument();
      expect(weekCard()).toBeNull();
    });

    it("triage replaces the banner, and the week review outranks triage", async () => {
      ipcMock.listActionItems.mockResolvedValue([
        item({ task: "Mouldy task", meeting_date: staleDate() }),
      ]);
      renderView();
      await screen.findByText("Mouldy task");
      closeWeekReviewIfOpen();

      // Banner → Review swaps in the triage panel (never both).
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      expect(triagePanel()).toBeInTheDocument();
      expect(staleBanner()).toBeNull();
      expect(weekCard()).toBeNull();

      // Opening the week review mid-triage shows ONLY the week review…
      fireEvent.click(screen.getByRole("button", { name: "Week review" }));
      expect(weekCard()).toBeInTheDocument();
      expect(triagePanel()).toBeNull();
      expect(staleBanner()).toBeNull();

      // …and closing it resumes the triage that was underway.
      fireEvent.click(screen.getByRole("button", { name: "Week review" }));
      expect(triagePanel()).toBeInTheDocument();
      expect(weekCard()).toBeNull();
      expect(staleBanner()).toBeNull();
    });

    it("the week review's stale shortcut hands over to the triage panel", async () => {
      ipcMock.listActionItems.mockResolvedValue([
        item({ task: "Mouldy task", meeting_date: staleDate() }),
      ]);
      renderView();
      await screen.findByText("Mouldy task");
      closeWeekReviewIfOpen();
      fireEvent.click(screen.getByRole("button", { name: "Week review" }));

      fireEvent.click(screen.getByRole("button", { name: /older, review/ }));

      expect(triagePanel()).toBeInTheDocument();
      expect(weekCard()).toBeNull();
      expect(staleBanner()).toBeNull();
    });
  });

  describe("multi-select & bulk actions (plan v10 #10)", () => {
    const selectBox = (task: string) =>
      screen.getByRole("checkbox", { name: `Select “${task}”` });

    it("bulk Complete hits every selected item, refreshes the list ONCE, and mirrors each distinct meeting", async () => {
      ipcMock.listActionItems.mockResolvedValue([
        item({ note_id: "n1", meeting_id: "m1", index: 0, task: "Task one" }),
        item({ note_id: "n2", meeting_id: "m2", index: 1, task: "Task two" }),
        item({ note_id: "n3", meeting_id: "m1", index: 2, task: "Task three" }),
      ]);
      const { qc } = renderView();
      await screen.findByText("Task one");

      fireEvent.click(selectBox("Task one"));
      fireEvent.click(selectBox("Task two"));
      fireEvent.click(selectBox("Task three"));
      expect(screen.getByText("3 selected")).toBeInTheDocument();

      const invalidate = vi.spyOn(qc, "invalidateQueries");
      fireEvent.click(screen.getByRole("button", { name: "Complete" }));

      await waitFor(() => {
        expect(ipcMock.setActionItemDone).toHaveBeenCalledTimes(3);
      });
      expect(ipcMock.setActionItemDone).toHaveBeenCalledWith("n1", "generated", 0, true, expect.any(String));
      expect(ipcMock.setActionItemDone).toHaveBeenCalledWith("n2", "generated", 1, true, expect.any(String));
      expect(ipcMock.setActionItemDone).toHaveBeenCalledWith("n3", "generated", 2, true, expect.any(String));

      // ONE action-items invalidation for the whole batch — never per item.
      await waitFor(() => {
        const listRefreshes = invalidate.mock.calls.filter(
          (c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === "action-items",
        );
        expect(listRefreshes).toHaveLength(1);
      });
      // Vault mirror: once per DISTINCT meeting (m1 twice-touched, m2 once).
      expect(scheduleMirror).toHaveBeenCalledTimes(2);
      expect(scheduleMirror).toHaveBeenCalledWith("m1");
      expect(scheduleMirror).toHaveBeenCalledWith("m2");
      // Mutating bulk ops clear the selection afterwards.
      await waitFor(() => {
        expect(screen.queryByText("3 selected")).not.toBeInTheDocument();
      });
    });

    it("shift-click selects the whole range from the anchor", async () => {
      ipcMock.listActionItems.mockResolvedValue([
        item({ index: 0, task: "T0" }),
        item({ index: 1, task: "T1" }),
        item({ index: 2, task: "T2" }),
        item({ index: 3, task: "T3" }),
      ]);
      renderView();
      await screen.findByText("T0");

      fireEvent.click(selectBox("T0"));
      fireEvent.click(selectBox("T2"), { shiftKey: true });

      expect(screen.getByText("3 selected")).toBeInTheDocument(); // T0, T1, T2
      expect(selectBox("T1")).toBeChecked();
      expect(selectBox("T3")).not.toBeChecked();
    });

    it("⌘A inside the list selects only what the current filters show", async () => {
      ipcMock.listActionItems.mockResolvedValue([
        item({ note_id: "a1", index: 0, task: "Amy one", assignee: "Amy" }),
        item({ note_id: "a2", index: 1, task: "Amy two", assignee: "Amy" }),
        item({ note_id: "g1", index: 2, task: "Sam one", assignee: "Sam" }),
      ]);
      renderView();
      await screen.findByText("Amy one");

      fireEvent.change(screen.getByLabelText("Filter by assignee"), { target: { value: "Amy" } });
      fireEvent.keyDown(selectBox("Amy one"), { key: "a", metaKey: true });

      expect(screen.getByText("2 selected")).toBeInTheDocument();

      // And the ops really act on that filtered selection only.
      fireEvent.click(screen.getByRole("button", { name: "Complete" }));
      await waitFor(() => {
        expect(ipcMock.setActionItemDone).toHaveBeenCalledTimes(2);
      });
      expect(ipcMock.setActionItemDone).not.toHaveBeenCalledWith("g1", "generated", 2, true);
    });

    it("Escape clears the selection and restores the filter row", async () => {
      ipcMock.listActionItems.mockResolvedValue([item({ task: "Escapable" })]);
      renderView();
      await screen.findByText("Escapable");

      fireEvent.click(selectBox("Escapable"));
      expect(screen.getByText("1 selected")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "All" })).not.toBeInTheDocument();

      fireEvent.keyDown(selectBox("Escapable"), { key: "Escape" });

      expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    });

    it("bulk Send to Things builds the URL from the SELECTION, not everything visible", async () => {
      ipcMock.listActionItems.mockResolvedValue([
        item({ index: 0, task: "Pick me", meeting_id: "m-1" }),
        item({ index: 1, task: "Not me", meeting_id: "m-2" }),
      ]);
      ipcMock.openUrl.mockResolvedValue(undefined);
      renderView();
      await screen.findByText("Pick me");

      fireEvent.click(selectBox("Pick me"));
      // The SELECTION bar keeps its direct button — it acts on the
      // explicit selection, not the view.
      fireEvent.click(screen.getByRole("button", { name: "Send to Things" }));

      await waitFor(() => {
        expect(ipcMock.openUrl).toHaveBeenCalledTimes(1);
      });
      const url: string = ipcMock.openUrl.mock.calls[0][0];
      const payload = JSON.parse(decodeURIComponent(url.slice("things:///json?data=".length)));
      expect(payload).toHaveLength(1); // selection, though two tasks are visible
      expect(payload[0].attributes.title).toBe("Pick me");
      // Hand-offs change nothing here, so the selection survives them.
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });

    it("bulk Snooze 1w snoozes each selected item a week out", async () => {
      // Local-calendar math, same as the app (the old UTC version of this
      // line failed every evening in US timezones — the exact bug the view
      // was fixed for).
      const now = new Date();
      const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 12)
        .toISOString()
        .slice(0, 10);
      ipcMock.listActionItems.mockResolvedValue([
        item({ note_id: "n1", index: 0, task: "S0" }),
        item({ note_id: "n2", index: 1, task: "S1" }),
      ]);
      renderView();
      await screen.findByText("S0");

      fireEvent.click(selectBox("S0"));
      fireEvent.click(selectBox("S1"), { shiftKey: true });
      fireEvent.click(screen.getByRole("button", { name: "Snooze 1w" }));

      await waitFor(() => {
        expect(ipcMock.setTaskSnooze).toHaveBeenCalledTimes(2);
      });
      expect(ipcMock.setTaskSnooze).toHaveBeenCalledWith("n1", "generated", 0, expected, expect.any(String));
      expect(ipcMock.setTaskSnooze).toHaveBeenCalledWith("n2", "generated", 1, expected, expect.any(String));
    });

    it("bulk Drop uses the overlay per selected item (notes untouched)", async () => {
      ipcMock.listActionItems.mockResolvedValue([
        item({ note_id: "n1", index: 0, task: "D0" }),
        item({ note_id: "n2", index: 1, task: "D1" }),
      ]);
      renderView();
      await screen.findByText("D0");

      fireEvent.click(selectBox("D0"));
      fireEvent.click(selectBox("D1"), { shiftKey: true });
      fireEvent.click(screen.getByRole("button", { name: "Drop" }));

      await waitFor(() => {
        expect(ipcMock.setTaskDropped).toHaveBeenCalledTimes(2);
      });
      expect(ipcMock.setTaskDropped).toHaveBeenCalledWith("n1", "generated", 0, true, expect.any(String));
      expect(ipcMock.setTaskDropped).toHaveBeenCalledWith("n2", "generated", 1, true, expect.any(String));
      expect(ipcMock.setActionItemDone).not.toHaveBeenCalled();
    });

    it("keyboard: the checkbox is a plain Tab stop, Space toggles it, and row controls keep their roles", async () => {
      ipcMock.listActionItems.mockResolvedValue([item({ task: "Keyed task" })]);
      renderView();
      await screen.findByText("Keyed task");
      const user = userEvent.setup();

      // Tasks rows are deliberately NOT roving-tabindex (their inline
      // controls would be orphaned) — every control is a natural Tab stop.
      const cb = selectBox("Keyed task");
      expect(cb.tabIndex).toBe(0);
      let guard = 0;
      while (document.activeElement !== cb && guard++ < 30) await user.tab();
      expect(document.activeElement).toBe(cb);

      await user.keyboard(" ");
      expect(screen.getByText("1 selected")).toBeInTheDocument();
      await user.keyboard(" ");
      expect(screen.queryByText("1 selected")).not.toBeInTheDocument();

      // No tabindex regressions on the row's existing controls.
      const done = screen.getByRole("button", { name: "Mark done" });
      const open = screen.getByRole("button", { name: /Keyed task/ });
      const snooze1d = screen.getByRole("button", { name: "Snooze 1d" });
      const snooze1w = screen.getByRole("button", { name: "1w" });
      for (const el of [done, open, snooze1d, snooze1w]) {
        expect(el.tabIndex).toBe(0);
      }
    });
  });
});
