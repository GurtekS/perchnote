import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { ipc, ActionItem } from "../../lib/ipc";
import { WeekReviewCard } from "./WeekReviewCard";
import { formatDeadline } from "../../lib/tiptap/formatDeadline";
import { buildThingsUrl } from "../../lib/thingsExport";
import { scheduleMirror } from "../../lib/mirrorLifecycle";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { localISODate, localISODatePlusDays } from "../../lib/localDate";

type StatusFilter = "open" | "all";
type SortKey = "due" | "meeting" | "assignee";

const UNASSIGNED = "__unassigned__";

// Parse a deadline string to a sortable epoch; missing/invalid sorts last.
/** Is this task currently snoozed (hidden from the default lens)? */
export function isSnoozed(i: { snoozed_until?: string | null }, today: string): boolean {
  return !!i.snoozed_until && i.snoozed_until.slice(0, 10) > today;
}

/** Due bucket for grouped headers (plan v5 rank 3). */
export function dueBucket(
  deadline: string | null,
  today: string,
): "Overdue" | "Today" | "This week" | "Later" | "No date" {
  if (!deadline) return "No date";
  const d = deadline.slice(0, 10);
  if (d < today) return "Overdue";
  if (d === today) return "Today";
  const weekOut = new Date(new Date(today).getTime() + 7 * 86400_000)
    .toISOString()
    .slice(0, 10);
  if (d <= weekOut) return "This week";
  return "Later";
}

/** Weeks since the originating meeting; null when no date. */
export function ageWeeks(meetingDate: string | null, today: string): number | null {
  if (!meetingDate) return null;
  const days = Math.floor(
    (new Date(today).getTime() - new Date(meetingDate.slice(0, 10)).getTime()) / 86400_000,
  );
  return days >= 0 ? Math.floor(days / 7) : null;
}

/** Stale = open, unparked, from a meeting over two weeks old (plan v5 rank 4). */
export function isStale(
  i: { done: boolean; dropped?: boolean; snoozed_until?: string | null; meeting_date: string | null },
  today: string,
): boolean {
  if (i.done || i.dropped || isSnoozed(i, today)) return false;
  const w = ageWeeks(i.meeting_date, today);
  return w !== null && w >= 2;
}

function deadlineValue(deadline: string | null): number {
  if (!deadline) return Number.POSITIVE_INFINITY;
  const t = new Date(deadline).getTime();
  return isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function isOverdue(item: ActionItem, now: Date): boolean {
  if (item.done || !item.deadline) return false;
  const t = new Date(item.deadline).getTime();
  if (isNaN(t)) return false;
  const d = new Date(t);
  const day = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return day < today;
}

// Stable per-item key (a task is addressed by note + body + position).
const itemKey = (i: ActionItem) => `${i.note_id}:${i.source}:${i.index}`;

export function TasksView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<StatusFilter>("open");
  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [sendingThings, setSendingThings] = useState(false);
  const [assignee, setAssignee] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("due");

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["action-items"],
    queryFn: ipc.listActionItems,
  });

  const toggle = useMutation({
    mutationFn: (i: ActionItem) =>
      ipc.setActionItemDone(i.note_id, i.source, i.index, !i.done, i.task),
    onMutate: async (i: ActionItem) => {
      await queryClient.cancelQueries({ queryKey: ["action-items"] });
      const prev = queryClient.getQueryData<ActionItem[]>(["action-items"]);
      queryClient.setQueryData<ActionItem[]>(["action-items"], (old) =>
        (old ?? []).map((x) =>
          itemKey(x) === itemKey(i) ? { ...x, done: !x.done } : x,
        ),
      );
      return { prev };
    },
    onError: (_e, _i, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["action-items"], ctx.prev);
      toast.error("Couldn't update that task — refreshing.");
      queryClient.invalidateQueries({ queryKey: ["action-items"] });
    },
    onSettled: (_d, _e, i) => {
      queryClient.invalidateQueries({ queryKey: ["action-items"] });
      queryClient.invalidateQueries({ queryKey: ["note", i.meeting_id] });
      // The toggle writes into the note JSON — the vault mirror should
      // follow, like any other note save (closes B2's noted gap).
      scheduleMirror(i.meeting_id);
    },
  });

  // Distinct assignees for the filter dropdown.
  const assignees = useMemo(() => {
    const set = new Set<string>();
    let hasUnassigned = false;
    for (const i of items) {
      if (i.assignee && i.assignee.trim()) set.add(i.assignee.trim());
      else hasUnassigned = true;
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b));
    return { list, hasUnassigned };
  }, [items]);

  const now = new Date();
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [triaging, setTriaging] = useState(false);
  const [triageDismissed, setTriageDismissed] = useState(false);
  // Week in review (plan v5 rank 5): open by default on Mondays, on demand
  // any other day.
  const [showReview, setShowReview] = useState(() => new Date().getDay() === 1);

  // Multi-select (plan v10 #10): selected row keys plus the shift-click
  // anchor. Bulk ops always act on selected ∩ visible, and any lens/filter/
  // sort change clears the whole set — the simplest rule that can never
  // resurrect a selection the user stopped seeing.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    setSelected((prev) => (prev.size ? new Set<string>() : prev));
    setAnchorKey(null);
  }, [status, assignee, sort, showSnoozed]);

  const clearSelection = () => {
    setSelected(new Set());
    setAnchorKey(null);
  };

  const drop = async (i: ActionItem) => {
    try {
      await ipc.setTaskDropped(i.note_id, i.source, i.index, true, i.task);
      queryClient.invalidateQueries({ queryKey: ["action-items"] });
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  };

  const snooze = async (i: ActionItem, until: string | null) => {
    try {
      await ipc.setTaskSnooze(i.note_id, i.source, i.index, until, i.task);
      queryClient.invalidateQueries({ queryKey: ["action-items"] });
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  };


  const { data: meetingsForReview = [] } = useQuery({
    queryKey: ["meetings"],
    queryFn: ipc.listMeetings,
    enabled: showReview,
    staleTime: 60_000,
  });

  const todayStr = localISODate(now);
  const staleItems = useMemo(
    () => items.filter((i) => isStale(i, todayStr)),
    [items, todayStr],
  );
  const snoozedCount = items.filter((i) => !i.done && !i.dropped && isSnoozed(i, todayStr)).length;

  const visible = useMemo(() => {
    let rows = items.filter((i) => !i.dropped);
    if (status === "open") {
      rows = rows.filter((i) => !i.done && (showSnoozed ? isSnoozed(i, todayStr) : !isSnoozed(i, todayStr)));
    }
    if (assignee !== "all") {
      rows = rows.filter((i) =>
        assignee === UNASSIGNED
          ? !i.assignee || !i.assignee.trim()
          : i.assignee?.trim() === assignee,
      );
    }
    rows.sort((a, b) => {
      if (sort === "due") return deadlineValue(a.deadline) - deadlineValue(b.deadline);
      if (sort === "assignee")
        return (a.assignee ?? "~").localeCompare(b.assignee ?? "~");
      // meeting: most recent meeting first
      return (b.meeting_date ?? "").localeCompare(a.meeting_date ?? "");
    });
    return rows;
  }, [items, status, assignee, sort, showSnoozed, todayStr]);

  // Render cap (whole-app review P3): thousands of action items rendered
  // as one unvirtualized DOM. 500 keeps the view responsive; the footer
  // says what's hidden and how to reach it. Selection/exports/bulk all key
  // off `visible`, so they honestly act on what's on screen.
  const RENDER_CAP = 500;
  const totalMatching = visible.length;
  const visibleCapped = useMemo(
    () => (visible.length > RENDER_CAP ? visible.slice(0, RENDER_CAP) : visible),
    [visible],
  );

  const openCount = items.filter((i) => !i.done).length;

  // The set both hand-offs operate on: exactly what the user is looking at,
  // minus done rows (dropped/snoozed are already excluded by `visible`).
  const visibleOpen = useMemo(() => visible.filter((i) => !i.done), [visible]);

  // Selection only counts where it can be seen (refetches can pull rows out
  // from under a checked key; such strays never act and never resurrect).
  const selectedVisible = useMemo(
    () => visibleCapped.filter((i) => selected.has(itemKey(i))),
    [visibleCapped, selected],
  );
  const selectedOpen = useMemo(
    () => selectedVisible.filter((i) => !i.done),
    [selectedVisible],
  );

  // Click = toggle; shift-click = extend the range from the anchor (macOS
  // convention: a plain click moves the anchor, extending doesn't).
  const toggleSelect = (i: ActionItem, shift: boolean) => {
    const key = itemKey(i);
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchorKey) {
        const keys = visibleCapped.map(itemKey);
        const a = keys.indexOf(anchorKey);
        const b = keys.indexOf(key);
        if (a !== -1 && b !== -1) {
          for (let k = Math.min(a, b); k <= Math.max(a, b); k++) next.add(keys[k]);
          return next;
        }
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!shift || !anchorKey) setAnchorKey(key);
  };

  // Bulk ops (plan v10 #10): the existing per-item ipc calls run
  // sequentially, then ONE list refresh for the whole batch — not one per
  // item. Mutating ops clear the selection; the hand-offs (Things/Reminders)
  // keep it, since they change nothing here.
  const runBulk = async (
    targets: ActionItem[],
    op: (i: ActionItem) => Promise<void>,
    successMsg: (n: number) => string,
    opts?: { mirrorNotes?: boolean },
  ) => {
    if (targets.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    const touchedMeetings = new Set<string>();
    const acted = new Set<string>();
    let ok = 0;
    try {
      for (const i of targets) {
        await op(i);
        ok++;
        acted.add(itemKey(i));
        if (opts?.mirrorNotes) touchedMeetings.add(i.meeting_id);
      }
      toast.success(successMsg(ok));
      clearSelection();
    } catch (e) {
      // A mid-batch failure must not lose the remainder: say how far the
      // batch got, and keep only the un-acted rows selected for a retry.
      toast.error(toUserMessage(e), `${ok} of ${targets.length} done — the rest stay selected`);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const k of acted) next.delete(k);
        return next;
      });
    } finally {
      queryClient.invalidateQueries({ queryKey: ["action-items"] });
      // Completion writes into the note JSON — refresh and re-mirror each
      // affected meeting once, the same trail the single toggle leaves.
      for (const mid of touchedMeetings) {
        queryClient.invalidateQueries({ queryKey: ["note", mid] });
        scheduleMirror(mid);
      }
      setBulkBusy(false);
    }
  };

  const bulkComplete = () =>
    runBulk(
      selectedOpen,
      (i) => ipc.setActionItemDone(i.note_id, i.source, i.index, true, i.task),
      (n) => `Completed ${n} task${n === 1 ? "" : "s"}`,
      { mirrorNotes: true },
    );

  const bulkSnooze = () => {
    // Same date math as the row's "1w" button: a week out, hidden until then.
    const d = localISODatePlusDays(7, now);
    return runBulk(
      selectedOpen,
      (i) => ipc.setTaskSnooze(i.note_id, i.source, i.index, d, i.task),
      (n) => `Snoozed ${n} task${n === 1 ? "" : "s"} until ${d}`,
    );
  };

  const bulkDrop = () =>
    runBulk(
      selectedOpen,
      (i) => ipc.setTaskDropped(i.note_id, i.source, i.index, true, i.task),
      (n) => `Dropped ${n} task${n === 1 ? "" : "s"} — the notes keep them as written`,
    );

  // Plan rank 7: hand the given open tasks to Apple Reminders (the action
  // row passes everything visible, the selection toolbar passes the checked).
  const exportToReminders = async (open: ActionItem[]) => {
    if (open.length === 0) {
      toast.error("No open tasks in this view to export");
      return;
    }
    setExporting(true);
    try {
      const n = await ipc.exportTasksToReminders(
        open.map((i) => ({
          task: i.task || "(untitled task)",
          body: `From “${i.meeting_title}” in Perchnote${i.assignee?.trim() ? ` — ${i.assignee.trim()}` : ""}`,
          deadline: i.deadline,
          note_id: i.note_id,
          source: i.source,
          index: i.index,
        })),
      );
      toast.success(`Exported ${n} task${n === 1 ? "" : "s"} to Reminders`);
    } catch (e) {
      toast.error(toUserMessage(e, "Reminders export failed"), "Reminders export failed");
    } finally {
      setExporting(false);
    }
  };

  // Plan v8 B6: hand the visible open tasks to Things via ONE things:///json
  // call. One-way by design — Things has no readback API, so unlike the
  // Reminders flow (reminder_links + pullReminderCompletions) completing a
  // task in Things never syncs back here. We also deliberately skip any
  // "already sent" marking for v1 (no readback means no reliable dedupe):
  // every click sends exactly the visible set the user chose, so re-sending
  // after a filter change is the user's explicit, predictable choice rather
  // than a silently partial export.
  const sendToThings = async (list: ActionItem[]) => {
    if (list.length === 0) return;
    setSendingThings(true);
    try {
      await ipc.openUrl(buildThingsUrl(list));
      toast.success(
        `Sent ${list.length} task${list.length === 1 ? "" : "s"} to Things — completing them there won't sync back`,
      );
    } catch (e) {
      toast.error(toUserMessage(e, "Things hand-off failed"), "Things hand-off failed");
    } finally {
      setSendingThings(false);
    }
  };
  // Reflect Reminders-side completions (plan v5): one osascript round-trip
  // on mount/focus; checking a task off in Apple Reminders flips it here.
  const queryClientForPull = useQueryClient();
  useEffect(() => {
    let last = 0;
    const pull = async () => {
      if (Date.now() - last < 30_000) return;
      last = Date.now();
      try {
        const n = await ipc.pullReminderCompletions();
        if (n > 0) {
          queryClientForPull.invalidateQueries({ queryKey: ["action-items"] });
          toast.success(`${n} task${n === 1 ? "" : "s"} completed in Reminders — synced`);
        }
      } catch {
        /* Reminders not granted / list absent — quiet */
      }
    };
    pull();
    const onFocus = () => pull();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [queryClientForPull]);

  const overdueCount = items.filter((i) => isOverdue(i, now)).length;

  // At most ONE review surface above the list (UX audit: the week review
  // card, the stale banner, and the triage panel could stack three deep).
  // Precedence: week review > triage > stale banner — the banner collapses
  // while the others are open and returns when they close; triage replaces
  // the banner rather than stacking under it.
  const reviewSurface: "week" | "triage" | "banner" | null = showReview
    ? "week"
    : triaging
      ? "triage"
      : staleItems.length > 0 && !triageDismissed
        ? "banner"
        : null;

  return (
    <div
      className="mx-auto w-full max-w-[860px] px-4 py-5 sm:px-6"
      onKeyDown={(e) => {
        // Esc anywhere in the view drops the selection (and stays here —
        // it shouldn't double as "close overlay" while it has work to do).
        if (e.key === "Escape" && selected.size > 0) {
          e.stopPropagation();
          clearSelection();
        }
      }}
    >
      <header className="mb-4 flex items-center gap-2">
        <ListChecks size={18} className="text-accent" />
        <h1 className="text-lg font-semibold text-text-primary">Tasks</h1>
        <span className="text-sm text-text-muted">{openCount} open</span>
        {overdueCount > 0 && (
          <span
            className="rounded-full bg-recording/10 px-2 py-0.5 text-xs font-medium text-recording"
            title="Open tasks past their due date"
          >
            {overdueCount} overdue
          </span>
        )}
      </header>

      {reviewSurface === "week" && (
        <WeekReviewCard
          items={items}
          meetings={meetingsForReview}
          today={todayStr}
          onReviewStale={() => {
            setShowReview(false);
            setTriaging(true);
          }}
        />
      )}

      {/* Stale triage (plan v5 rank 4): the rotting tail gets a conscious
          decision — Done, Snooze, or Drop — instead of silent guilt. */}
      {reviewSurface === "banner" && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2">
          <p className="m-0 text-xs text-text-secondary">
            {staleItems.length} item{staleItems.length === 1 ? "" : "s"} from meetings over two
            weeks old
          </p>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTriaging(true)}
              className="rounded-md border border-amber-400/40 px-2 py-0.5 text-xs text-amber-500 hover:bg-amber-400/10"
            >
              Review
            </button>
            <button
              type="button"
              onClick={() => setTriageDismissed(true)}
              aria-label="Later — dismiss stale-items reminder"
              className="rounded-md px-1.5 py-0.5 text-xs text-text-muted hover:bg-bg-hover"
            >
              Later
            </button>
          </span>
        </div>
      )}
      {reviewSurface === "triage" && (
        <div className="card mb-4 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="section-label m-0">Review stale items ({staleItems.length} left)</p>
            <button
              type="button"
              onClick={() => setTriaging(false)}
              className="rounded-md px-1.5 py-0.5 text-xs text-text-muted hover:bg-bg-hover"
            >
              Done reviewing
            </button>
          </div>
          {staleItems.length === 0 ? (
            <p className="m-0 py-2 text-sm text-text-secondary">
              All clear — nothing stale left. 🎉
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {staleItems.slice(0, 8).map((i) => (
                <li
                  key={itemKey(i)}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                    {i.task || "(untitled task)"}
                  </span>
                  <span className="shrink-0 text-footnote text-text-muted">
                    {ageWeeks(i.meeting_date, todayStr)}w · {i.meeting_title}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => toggle.mutate(i)}
                      className="rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary hover:border-accent hover:text-accent"
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const d = localISODatePlusDays(7, now);
                        snooze(i, d);
                      }}
                      className="rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary hover:bg-bg-hover"
                    >
                      Snooze
                    </button>
                    <button
                      type="button"
                      onClick={() => drop(i)}
                      title="Remove from every list — the note keeps it as written"
                      className="rounded-md border border-border px-2 py-0.5 text-xs text-text-muted hover:text-recording hover:border-recording/40"
                    >
                      Drop
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Filters — while a selection is active the bulk-actions toolbar
          stands in for this row (changing the lens mid-selection would
          silently change what the actions hit; here it simply can't). */}
      {selectedVisible.length > 0 ? (
        <div
          role="group"
          aria-label="Bulk actions"
          className="mb-4 flex flex-wrap items-center gap-2"
        >
          <span aria-live="polite" className="px-1 text-xs font-medium text-text-primary">
            {selectedVisible.length} selected
          </span>
          <button
            type="button"
            onClick={bulkComplete}
            disabled={bulkBusy || selectedOpen.length === 0}
            title="Mark every selected task done"
            className="h-8 rounded-lg border border-accent/40 bg-accent/10 px-2.5 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            Complete
          </button>
          <button
            type="button"
            onClick={bulkSnooze}
            disabled={bulkBusy || selectedOpen.length === 0}
            title="Hide the selected tasks until next week"
            className="h-8 rounded-lg border border-border bg-bg-tertiary px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          >
            Snooze 1w
          </button>
          <button
            type="button"
            onClick={bulkDrop}
            disabled={bulkBusy || selectedOpen.length === 0}
            title="Remove the selected tasks from every list — the notes keep them as written"
            className="h-8 rounded-lg border border-border bg-bg-tertiary px-2.5 text-xs text-text-muted transition-colors hover:border-recording/40 hover:text-recording disabled:opacity-50"
          >
            Drop
          </button>
          <button
            type="button"
            onClick={() => sendToThings(selectedOpen)}
            disabled={bulkBusy || sendingThings || selectedOpen.length === 0}
            title="Create the selected open tasks as Things to-dos (one-way — completing them in Things won't sync back)"
            className="h-8 rounded-lg border border-border bg-bg-tertiary px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          >
            {sendingThings ? "Sending…" : "Send to Things"}
          </button>
          <button
            type="button"
            onClick={() => exportToReminders(selectedOpen)}
            disabled={bulkBusy || exporting || selectedOpen.length === 0}
            title="Create the selected open tasks as reminders in a “Perchnote” list (with due dates)"
            className="h-8 rounded-lg border border-border bg-bg-tertiary px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export to Reminders"}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            title="Deselect everything (Esc)"
            className="h-8 rounded-lg px-2.5 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            Clear
          </button>
        </div>
      ) : (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="view-toggle-pill" role="group" aria-label="Status filter">
          <button
            type="button"
            onClick={() => setStatus("open")}
            className={status === "open" ? "active" : ""}
            aria-pressed={status === "open"}
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => setStatus("all")}
            className={status === "all" ? "active" : ""}
            aria-pressed={status === "all"}
          >
            All
          </button>
        </div>

        {snoozedCount > 0 && status === "open" && (
          <button
            type="button"
            onClick={() => setShowSnoozed(!showSnoozed)}
            aria-pressed={showSnoozed}
            className={`h-8 rounded-lg border px-2.5 text-xs transition-colors ${
              showSnoozed
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
            title="Tasks hidden until a later date"
          >
            Snoozed ({snoozedCount})
          </button>
        )}

        <select
          aria-label="Filter by assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="h-8 rounded-lg border border-border bg-bg-tertiary px-2.5 text-xs text-text-secondary focus:outline-none focus:border-accent"
        >
          <option value="all">All assignees</option>
          {assignees.list.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
          {assignees.hasUnassigned && <option value={UNASSIGNED}>Unassigned</option>}
        </select>

        <select
          aria-label="Sort tasks"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="h-8 rounded-lg border border-border bg-bg-tertiary px-2.5 text-xs text-text-secondary focus:outline-none focus:border-accent"
        >
          <option value="due">Sort: Due date</option>
          <option value="meeting">Sort: Meeting</option>
          <option value="assignee">Sort: Assignee</option>
        </select>

        {assignee !== "all" && assignee !== UNASSIGNED && (
          <button
            type="button"
            onClick={async () => {
              const theirs = visible.filter((i) => !i.done);
              const lines = theirs.map((i) => {
                const due = i.deadline ? ` (due ${i.deadline.slice(0, 10)})` : "";
                return `- ${i.task}${due} — from “${i.meeting_title}”`;
              });
              const text = `Open items for ${assignee}:\n${lines.join("\n")}`;
              try {
                await navigator.clipboard.writeText(text);
                toast.success(`Copied ${theirs.length} item${theirs.length === 1 ? "" : "s"} for ${assignee}`);
              } catch {
                toast.error("Couldn't access the clipboard");
              }
            }}
            className="h-8 rounded-lg border border-border bg-bg-tertiary px-2.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            title="Copy this person's open items as an email-ready list"
          >
            Copy follow-up
          </button>
        )}

        <button
          type="button"
          onClick={() => setShowReview(!showReview)}
          aria-pressed={showReview}
          className={`h-8 rounded-lg border px-2.5 text-xs transition-colors ${
            showReview
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover"
          }`}
          title="Last week's meetings, open items by age, and what's due next"
        >
          Week review
        </button>

        {/* Hand-offs live behind one menu (UI review #4): the toolbar
            mixed actions-on-data with views-of-data — seven controls in
            a row. */}
        <div
          className="relative"
          onKeyDown={(e) => {
            // role=menu promises keyboard behavior (deep review P2): Esc
            // closes, arrows move between the two items.
            if (!exportMenuOpen) return;
            if (e.key === "Escape") { e.stopPropagation(); setExportMenuOpen(false); }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const items = Array.from(
                (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
              );
              const idx = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
              items[next]?.focus();
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExportMenuOpen(false);
          }}
        >
          <button
            type="button"
            onClick={() => setExportMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            title="Send these tasks elsewhere"
            className="h-8 rounded-lg border border-border bg-bg-tertiary px-2.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover"
          >
            {exporting || sendingThings ? "Sending…" : "Send to…"}
          </button>
          {exportMenuOpen && (
            <div
              role="menu"
              className="glass-float absolute right-0 top-9 z-20 w-56 rounded-lg p-1"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => { setExportMenuOpen(false); exportToReminders(visibleOpen); }}
                disabled={exporting}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              >
                Apple Reminders
                <span className="block text-footnote text-text-muted">Creates a “Perchnote” list; completions sync back</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setExportMenuOpen(false); sendToThings(visibleOpen); }}
                disabled={sendingThings || visibleOpen.length === 0}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              >
                Things
                <span className="block text-footnote text-text-muted">One-way — completing there won't sync back</span>
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      {/* List */}
      {isLoading ? (
        <p className="px-1 py-8 text-sm text-text-muted">Loading tasks…</p>
      ) : visible.length === 0 ? (
        <div className="card px-4 py-10 text-center">
          <p className="text-sm font-medium text-text-secondary">
            {items.length === 0 ? "No tasks yet" : "Nothing matches these filters"}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Enhance a meeting or add action items to your notes and they'll roll up here.
          </p>
        </div>
      ) : (
        <>
        <ul
          className="flex flex-col gap-1"
          onKeyDown={(e) => {
            // ⌘A while focus is inside the list: select exactly what the
            // current lens/filters show — never the whole database.
            if (
              (e.metaKey || e.ctrlKey) &&
              !e.shiftKey &&
              !e.altKey &&
              e.key.toLowerCase() === "a"
            ) {
              e.preventDefault();
              setSelected(new Set(visibleCapped.map(itemKey)));
            }
          }}
        >
          {visibleCapped.map((i, rowIdx) => {
            const overdue = isOverdue(i, now);
            const due = formatDeadline(i.deadline);
            const isSelected = selected.has(itemKey(i));
            // Due-sort gains section headers (plan v5 rank 3) — grouping
            // makes the sort legible instead of one undifferentiated list.
            const bucket = sort === "due" && status === "open" && !showSnoozed
              ? dueBucket(i.deadline, todayStr)
              : null;
            const prevBucket = bucket && rowIdx > 0
              ? dueBucket(visibleCapped[rowIdx - 1].deadline, todayStr)
              : null;
            const showHeader = bucket !== null && bucket !== prevBucket;
            return (
              <li key={itemKey(i)} className="contents">
                {showHeader && (
                  <div className="section-label mt-3 px-1 first:mt-0">{bucket}</div>
                )}
                <div
                  className={`group flex items-center gap-3 rounded-[10px] border px-3 py-2.5 hover:border-border hover:bg-bg-hover ${
                    isSelected ? "border-accent/30 bg-accent/5" : "border-transparent"
                  }`}
                >
                {/* Selection checkbox (plan v10 #10). A native input keeps
                    the deliberate keyboard semantics of this list — rows are
                    NOT in the roving-tabindex scheme (their inline controls
                    would be orphaned), every control is a plain Tab stop and
                    Space toggles natively. Hidden until hover/focus/selection
                    so a user who never multi-selects sees nothing new. */}
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {/* handled in onClick, which carries shiftKey */}}
                  onClick={(e) => toggleSelect(i, e.shiftKey)}
                  aria-label={`Select “${i.task || "(untitled task)"}”`}
                  className={`h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent transition-opacity ${
                    selectedVisible.length > 0
                      ? "opacity-100"
                      : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  }`}
                />
                <button
                  type="button"
                  aria-label={i.done ? "Mark not done" : "Mark done"}
                  aria-pressed={i.done}
                  onClick={() => toggle.mutate(i)}
                  className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                    i.done
                      ? "border-accent bg-accent text-white"
                      : "border-border hover:border-accent"
                  }`}
                >
                  {i.done && (
                    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                      <path d="M3 8l3 3 7-7" stroke="white" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => navigate({ to: "/meeting/$id", params: { id: i.meeting_id } })}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className={`min-w-0 flex-1 truncate text-sm ${i.done ? "text-text-muted line-through" : "text-text-primary"}`}>
                    {i.task || "(untitled task)"}
                  </span>

                  {i.assignee && i.assignee.trim() && (
                    <span className="hidden shrink-0 items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-caption text-text-secondary sm:inline-flex">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent/20 text-[9px] text-accent">
                        {i.assignee.trim()[0]?.toUpperCase() ?? "?"}
                      </span>
                      {i.assignee.trim()}
                    </span>
                  )}

                  {due && (
                    <span className={`shrink-0 text-caption ${overdue ? "text-recording" : "text-text-muted"}`}>
                      {due}
                    </span>
                  )}
                  {!due && !i.done && (ageWeeks(i.meeting_date, todayStr) ?? 0) >= 2 && (
                    <span
                      className={`shrink-0 text-caption ${(ageWeeks(i.meeting_date, todayStr) ?? 0) >= 4 ? "text-amber-500" : "text-text-muted"}`}
                      title="Weeks since the meeting this came from"
                    >
                      {ageWeeks(i.meeting_date, todayStr)}w
                    </span>
                  )}

                  <span className="hidden max-w-[160px] shrink-0 truncate text-caption text-text-muted md:inline">
                    {i.meeting_title}
                  </span>
                </button>

                {/* Snooze (overlay-only — the meeting-stated deadline is never touched) */}
                {!i.done && (
                  showSnoozed || isSnoozed(i, todayStr) ? (
                    <button
                      type="button"
                      onClick={() => snooze(i, null)}
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-caption text-text-muted opacity-0 transition-opacity hover:bg-bg-tertiary hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                      title="Bring this task back now"
                    >
                      Unsnooze
                    </button>
                  ) : (
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => {
                          const d = localISODatePlusDays(1, now);
                          snooze(i, d);
                        }}
                        className="rounded-md px-1.5 py-0.5 text-caption text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
                        title="Hide until tomorrow"
                      >
                        Snooze 1d
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const d = localISODatePlusDays(7, now);
                          snooze(i, d);
                        }}
                        className="rounded-md px-1.5 py-0.5 text-caption text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
                        title="Hide until next week"
                      >
                        1w
                      </button>
                    </span>
                  )
                )}
                </div>
              </li>
            );
          })}
        </ul>
        {totalMatching > RENDER_CAP && (
          <p className="px-1 py-3 text-xs text-text-muted">
            Showing {RENDER_CAP} of {totalMatching} tasks — narrow the filter or
            lens to see the rest.
          </p>
        )}
        </>
      )}
    </div>
  );
}
