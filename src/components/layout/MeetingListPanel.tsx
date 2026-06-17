import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useNavigate, useMatchRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pin, Archive, Trash2, Search, FolderIcon, FolderInput,
  LayoutList, X, Check, PanelLeftClose,
} from "lucide-react";
import { useUIStore } from "../../stores/uiStore";
import { MeetingBanner } from "./MeetingBanner";
import { ipc, Meeting, Folder, buildFolderTree, FolderNode } from "../../lib/ipc";
import { format, isToday, isYesterday, isThisWeek, isTomorrow } from "date-fns";
import { ContextMenu, ContextMenuItem, ContextSubItem } from "../shared/ContextMenu";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { useRecordingStore } from "../../stores/recordingStore";
import { startPendingDrag, consumeDragOccurred } from "../../lib/meetingDrag";
import { MeetingStatusBadge } from "../shared/MeetingStatusBadge";
import { useRovingFocus } from "../../hooks/useRovingFocus";

// ─── Helpers (same as Sidebar.tsx) ───────────────────────────────────────────

function getMeetingDate(meeting: Meeting): Date | null {
  const raw = meeting.scheduled_start || meeting.actual_start || meeting.created_at;
  if (!raw) return null;
  return new Date(raw);
}

// A meeting belongs in "Upcoming" only if it has a *future* scheduled time
// AND its status hasn't already moved on. A freshly-created untitled draft
// (status=upcoming, no scheduled_start) is NOT upcoming — it falls into
// the timeline under Today.
function isUpcomingMeeting(m: Meeting): boolean {
  const isUpcomingStatus = m.status === "upcoming" || m.status === "ready" || m.status === "scheduled";
  if (!isUpcomingStatus) return false;
  if (!m.scheduled_start) return false;
  return new Date(m.scheduled_start) >= new Date();
}

// Whether the meeting has anything worth showing in the timeline:
// either a recording was actually started, or notes exist. Empty past
// calendar events (no actual_start, no notes) are filtered out.
function hasMeetingContent(m: Meeting): boolean {
  return m.actual_start != null || m.note_status !== "none";
}

// In-flight meetings should always be visible regardless of content,
// because the user is actively working on them right now.
function isInFlightMeeting(m: Meeting): boolean {
  return m.status === "recording" || m.status === "transcribing" || m.status === "generating";
}

function getMeetingTimeLabel(meeting: Meeting): string {
  const d = getMeetingDate(meeting);
  if (!d) return "";
  const group = getTimelineGroup(d);
  if (group === "Today") return format(d, "h:mm a");
  if (group === "Yesterday" || group === "This Week") return format(d, "EEE h:mm a");
  return format(d, "MMM d");
}

type TimelineGroup = "Today" | "Yesterday" | "This Week" | "Earlier";

function getTimelineGroup(date: Date): TimelineGroup {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  if (isThisWeek(date, { weekStartsOn: 1 })) return "This Week";
  return "Earlier";
}

// ─── MeetingListPanel ─────────────────────────────────────────────────────────

export function MeetingListPanel() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const queryClient = useQueryClient();
  const recordingMeetingId = useRecordingStore((s) => s.meetingId);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // One tab stop for the whole meeting list; ↑/↓/Home/End rove between
  // rows, Space toggles selection, Enter opens (plan v6 item 7).
  useRovingFocus(listRef, "[data-roving-item]");

  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Meeting | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkFolderPicker, setShowBulkFolderPicker] = useState(false);
  const isSelectMode = selectedIds.size > 0;

  // ─── Queries ───────────────────────────────────────────────────────────────

  const { data: meetings = [] } = useQuery<Meeting[]>({
    queryKey: ["meetings"],
    queryFn: () => invoke("list_meetings"),
  });

  const { data: folders = [] } = useQuery<Folder[]>({
    queryKey: ["folders"],
    queryFn: () => invoke("list_folders"),
  });

  // Folder memberships for the per-row "Move to folder…" submenu — same
  // one-round-trip map NotesList uses, same invalidation key.
  const { data: folderMembershipsData } = useQuery<Record<string, string[]>>({
    queryKey: ["folderMembershipsMap"],
    queryFn: ipc.getFolderMembershipsMap,
    staleTime: 5 * 60_000,
  });

  // ─── Listen for search focus event from IconRail ───────────────────────────

  useEffect(() => {
    const handler = () => {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    };
    document.addEventListener("focus-meeting-search", handler);
    return () => document.removeEventListener("focus-meeting-search", handler);
  }, []);

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedIds(new Set());
        setShowBulkFolderPicker(false);
        if (searchQuery) {
          setSearchQuery("");
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchQuery]);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const handleNewMeeting = async () => {
    const meeting = await ipc.createMeeting("Untitled Meeting");
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    navigate({ to: "/meeting/$id", params: { id: meeting.id } });
  };

  const handleDeleteMeeting = async () => {
    if (!deleteTarget) return;
    try {
      await ipc.softDeleteMeeting(deleteTarget.id);
    } catch (e) {
      // e.g. "this meeting is recording — stop first" (review P2 guard)
      toast.error(toUserMessage(e));
      setDeleteTarget(null);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    queryClient.invalidateQueries({ queryKey: ["deletedMeetings"] });
    toast.success(`"${deleteTarget.title}" moved to trash`);
    const deletedId = deleteTarget.id;
    setDeleteTarget(null);
    // Kick the user home only if they were LOOKING at the deleted meeting —
    // deleting an unrelated row used to eject them from the one they were
    // editing (whole-app review P3).
    if (window.location.pathname.includes(deletedId)) {
      navigate({ to: "/" });
    }
  };

  const handleTogglePin = useCallback(async (meeting: Meeting) => {
    const pinned = await ipc.togglePinMeeting(meeting.id);
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.info(pinned ? "Meeting pinned" : "Meeting unpinned");
  }, [queryClient]);

  const handleArchive = useCallback(async (meeting: Meeting) => {
    await ipc.archiveMeeting(meeting.id);
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    // Archive was a one-way door (friction audit #6) — undo here, and the
    // full archived list lives in Settings → Data.
    toast.action("Meeting archived", "Undo", async () => {
      await ipc.unarchiveMeeting(meeting.id);
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    });
  }, [queryClient]);

  // ─── Bulk actions ──────────────────────────────────────────────────────────

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setShowBulkFolderPicker(false);
  }, []);

  const handleSelectAll = useCallback(() => {
    const q = searchQuery.toLowerCase();
    const allIds = meetings
      .filter((m) => !q || m.title.toLowerCase().includes(q))
      .map((m) => m.id);
    setSelectedIds(new Set(allIds));
  }, [meetings, searchQuery]);

  // Confirmed like single delete (deep review P2: bulk had NO confirm and
  // unconditionally kicked the user Home — inverted risk handling). The
  // toast names the way back, and navigation only happens if the OPEN
  // meeting was among the deleted.
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    setConfirmBulkDelete(false);
    const results = await Promise.allSettled(ids.map((id) => ipc.softDeleteMeeting(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    queryClient.invalidateQueries({ queryKey: ["deletedMeetings"] });
    if (failed > 0) {
      toast.error(`${failed} of ${ids.length} couldn't be moved to trash`);
    } else {
      toast.success(`${ids.length} meeting${ids.length !== 1 ? "s" : ""} moved to trash. Restore from Trash below.`);
    }
    clearSelection();
    if (ids.some((id) => window.location.pathname.includes(id))) {
      navigate({ to: "/" });
    }
  };

  const handleBulkArchive = async () => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => ipc.archiveMeeting(id)));
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.action(
      `${ids.length} meeting${ids.length !== 1 ? "s" : ""} archived`,
      "Undo",
      async () => {
        await Promise.all(ids.map((id) => ipc.unarchiveMeeting(id)));
        queryClient.invalidateQueries({ queryKey: ["meetings"] });
      },
    );
    clearSelection();
  };

  const handleBulkMoveToFolder = async (folderId: string) => {
    const folderName = folders.find((f) => f.id === folderId)?.name || "folder";
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => ipc.addMeetingToFolder(id, folderId)));
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.success(`${ids.length} meeting${ids.length !== 1 ? "s" : ""} moved to "${folderName}"`);
    clearSelection();
  };

  // ─── Context menus ─────────────────────────────────────────────────────────

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  // Single-meeting "Move to folder…" submenu (deep review P2: the sidebar
  // context menu had no folder action, and a sidebar drag has no drop
  // target anywhere the panel renders). Same toggle-membership pattern as
  // NoteCard's submenu.
  const getFolderSubItems = useCallback(
    (meetingId: string): ContextSubItem[] => {
      const memberIds = new Set(folderMembershipsData?.[meetingId] ?? []);
      const items: ContextSubItem[] = [];
      const walk = (nodes: FolderNode[], depth: number) => {
        for (const node of nodes) {
          const isIn = memberIds.has(node.id);
          items.push({
            label: node.name,
            icon: (
              <span
                className="w-2 h-2 rounded-full shrink-0 inline-block"
                style={{ background: node.color }}
              />
            ),
            indent: depth,
            checked: isIn,
            onClick: async () => {
              try {
                if (isIn) await ipc.removeMeetingFromFolder(meetingId, node.id);
                else await ipc.addMeetingToFolder(meetingId, node.id);
                queryClient.invalidateQueries({ queryKey: ["meetings"] });
                queryClient.invalidateQueries({ queryKey: ["folders"] });
                queryClient.invalidateQueries({ queryKey: ["folderMembershipsMap"] });
                queryClient.invalidateQueries({ queryKey: ["folderMeetings", node.id] });
                queryClient.invalidateQueries({ queryKey: ["meetings", "folder", node.id] });
              } catch (e) {
                toast.error(toUserMessage(e));
              }
            },
          });
          walk(node.children, depth + 1);
        }
      };
      walk(folderTree, 0);
      return items;
    },
    [folderTree, folderMembershipsData, queryClient],
  );

  const getMeetingContextItems = useCallback(
    (meeting: Meeting): ContextMenuItem[] => {
      const folderSubItems = getFolderSubItems(meeting.id);
      return [
        {
          label: "Open",
          icon: <LayoutList size={14} />,
          onClick: () => navigate({ to: "/meeting/$id", params: { id: meeting.id } }),
        },
        {
          label: meeting.is_pinned ? "Unpin" : "Pin",
          icon: <Pin size={14} />,
          onClick: () => handleTogglePin(meeting),
        },
        {
          label: "Move to folder…",
          icon: <FolderInput size={14} />,
          submenu: {
            title: "Move to folder",
            items:
              folderSubItems.length > 0
                ? folderSubItems
                : [{ label: "No folders yet", onClick: () => {} }],
          },
        },
        {
          label: "Archive",
          icon: <Archive size={14} />,
          onClick: () => handleArchive(meeting),
        },
        {
          label: "Delete",
          icon: <Trash2 size={14} />,
          onClick: () => setDeleteTarget(meeting),
          variant: "danger",
          divider: true,
        },
      ];
    },
    [navigate, handleTogglePin, handleArchive, getFolderSubItems],
  );

  // ─── Filtered + grouped data ───────────────────────────────────────────────

  const lowerSearch = searchQuery.toLowerCase();

  const { data: trashCount = 0 } = useQuery({
    queryKey: ["deletedMeetings", "count"],
    queryFn: async () => (await ipc.listDeletedMeetings()).length,
    staleTime: 30_000,
  });

  const upcomingMeetings = useMemo(
    () =>
      meetings
        .filter((m) => isUpcomingMeeting(m) && (!lowerSearch || m.title.toLowerCase().includes(lowerSearch)))
        .sort((a, b) => (a.scheduled_start ?? "").localeCompare(b.scheduled_start ?? ""))
        .slice(0, 8),
    [meetings, lowerSearch],
  );

  const timelineMeetings = useMemo(() => {
    const nonUpcoming = meetings.filter(
      (m) =>
        !isUpcomingMeeting(m) &&
        (hasMeetingContent(m) || isInFlightMeeting(m)) &&
        (!lowerSearch || m.title.toLowerCase().includes(lowerSearch)),
    );
    nonUpcoming.sort((a, b) => {
      const da = getMeetingDate(a)?.getTime() ?? 0;
      const db = getMeetingDate(b)?.getTime() ?? 0;
      return db - da;
    });
    const groups: Record<TimelineGroup, Meeting[]> = {
      Today: [], Yesterday: [], "This Week": [], Earlier: [],
    };
    for (const m of nonUpcoming) {
      const d = getMeetingDate(m);
      groups[d ? getTimelineGroup(d) : "Earlier"].push(m);
    }
    return groups;
  }, [meetings, lowerSearch]);

  const visibleTimelineCount = Object.values(timelineMeetings).reduce(
    (total, group) => total + group.length,
    0,
  );
  const hasVisibleMeetings = upcomingMeetings.length > 0 || visibleTimelineCount > 0;

  const isActiveMeeting = useCallback(
    (id: string) => !!matchRoute({ to: "/meeting/$id", params: { id }, fuzzy: false }),
    [matchRoute],
  );

  // ─── Folder tree for bulk picker ───────────────────────────────────────────

  const allFolders = folders;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <aside
      data-pane="list"
      className="w-[244px] h-full flex flex-col shrink-0 overflow-hidden"
      style={{
        background: "var(--glass-panel-bg)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRight: "1px solid var(--glass-panel-border)",
      }}
    >
      {/* Recording banner (preserves MeetingBanner quick-stop) */}
      <MeetingBanner />

      {/* Header */}
      <div
        className="px-3.5 py-2.5 flex items-center gap-1.5 shrink-0"
        style={{ borderBottom: "1px solid var(--glass-header-border)" }}
      >
        <span
          className="flex-1 text-caption font-semibold tracking-widest uppercase"
          style={{ color: "var(--panel-label-color)" }}
        >
          Meetings
        </span>
        <button
          type="button"
          onClick={() => {
            useUIStore.getState().toggleSidebar();
            // This button unmounts with the panel it just hid — park
            // keyboard focus on the rail's show/hide toggle instead of
            // letting it drop to <body>.
            document.getElementById("rail-toggle-meeting-list")?.focus();
          }}
          className="w-6 h-6 rounded-md flex items-center justify-center transition-colors hover:bg-bg-hover"
          style={{ color: "var(--icon-color-dim)" }}
          title="Hide meeting list (⌘B)"
          aria-label="Hide meeting list"
          aria-expanded="true"
        >
          <PanelLeftClose size={14} />
        </button>
        <button
          type="button"
          onClick={handleNewMeeting}
          className="w-6 h-6 rounded-md flex items-center justify-center transition-colors"
          style={{ color: "var(--icon-color-dim)" }}
          title="New meeting without recording (⌘N creates one AND records)"
          aria-label="New meeting without recording"
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--icon-hover-bg)"; (e.currentTarget as HTMLElement).style.color = "var(--icon-color-bright)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; (e.currentTarget as HTMLElement).style.color = "var(--icon-color-dim)"; }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Search field */}
      <div className="px-2 py-1.5 shrink-0" style={{ borderBottom: "1px solid var(--glass-header-border)" }}>
        <div
          className="flex items-center gap-1.5 rounded-lg px-2 py-1"
          style={{ background: "var(--glass-search-bg)", border: "1px solid var(--glass-search-border)" }}
        >
          <Search size={11} style={{ color: "var(--search-icon-color)", flexShrink: 0 }} />
          <input
            ref={searchInputRef}
            type="text"
            aria-label="Search meetings"
            placeholder="Search meetings…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-caption outline-none placeholder:text-text-muted"
            style={{ color: "var(--search-text-color)" }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={11} style={{ color: "var(--search-icon-color)" }} />
            </button>
          )}
        </div>
      </div>

      {/* Bulk action bar */}
      {isSelectMode && (
        <div
          className="px-2 py-1.5 shrink-0 flex flex-col gap-1"
          style={{ borderBottom: "1px solid var(--glass-header-border)", background: "rgba(var(--accent-rgb),0.05)" }}
        >
          {!showBulkFolderPicker ? (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-caption flex-1" style={{ color: "var(--icon-color-bright)" }}>
                {selectedIds.size} selected
                {" · "}
                <button type="button" className="underline" onClick={handleSelectAll} style={{ color: "var(--accent)" }}>select visible</button>
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="w-5 h-5 flex items-center justify-center rounded"
                style={{ color: "var(--icon-color-dim)" }}
                title="Clear selection"
                aria-label="Clear selection"
              >
                <X size={12} />
              </button>
              <div className="w-full flex gap-1">
                <button type="button" onClick={handleBulkArchive} className="flex-1 text-caption py-0.5 rounded-md" style={{ background: "var(--icon-hover-bg)", color: "var(--icon-color-bright)" }}>Archive</button>
                <button type="button" onClick={() => setShowBulkFolderPicker(true)} className="flex-1 text-caption py-0.5 rounded-md" style={{ background: "var(--icon-hover-bg)", color: "var(--icon-color-bright)" }}>Move</button>
                <button type="button" onClick={() => setConfirmBulkDelete(true)} className="flex-1 text-caption py-0.5 rounded-md" style={{ background: "rgba(239,68,68,0.15)", color: "rgba(239,68,68,0.8)" }}>Delete</button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <button type="button" onClick={() => setShowBulkFolderPicker(false)} className="text-caption" style={{ color: "var(--accent)" }}>Back</button>
                <span className="text-caption flex-1 text-center" style={{ color: "var(--icon-color-dim)" }}>Move to folder</span>
              </div>
              {allFolders.length === 0 ? (
                <p className="px-2 py-1.5 text-caption" style={{ color: "var(--section-label-color)" }}>
                  No folders yet
                </p>
              ) : (
                allFolders.map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    onClick={() => handleBulkMoveToFolder(f.id)}
                    className="w-full text-left text-caption px-2 py-1 rounded-md flex items-center gap-2"
                    style={{ color: "var(--icon-color-bright)" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--icon-hover-bg)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
                  >
                    <FolderIcon size={12} />
                    {f.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* Meeting list */}
      <div ref={listRef} className="flex-1 overflow-y-auto py-1.5 px-1.5">
        {/* Upcoming */}
        {upcomingMeetings.length > 0 && (
          <div className="mb-1">
            <SectionLabel>Upcoming</SectionLabel>
            {upcomingMeetings.map((m) =>
              m.scheduled_start ? (
                <UpcomingEventRow
                  key={m.id}
                  meeting={m}
                  active={isActiveMeeting(m.id)}
                  recording={recordingMeetingId === m.id}
                  selected={selectedIds.has(m.id)}
                  onSelect={() => toggleSelect(m.id)}
                  contextItems={getMeetingContextItems(m)}
                  onClick={() => navigate({ to: "/meeting/$id", params: { id: m.id } })}
                />
              ) : (
                <MeetingRow
                  key={m.id}
                  meeting={m}
                  active={isActiveMeeting(m.id)}
                  recording={recordingMeetingId === m.id}
                  selected={selectedIds.has(m.id)}
                  onSelect={() => toggleSelect(m.id)}
                  contextItems={getMeetingContextItems(m)}
                  onClick={() => navigate({ to: "/meeting/$id", params: { id: m.id } })}
                />
              )
            )}
          </div>
        )}

        {/* Timeline groups */}
        {(["Today", "Yesterday", "This Week", "Earlier"] as TimelineGroup[]).map((group) => {
          const items = timelineMeetings[group];
          if (!items.length) return null;
          return (
            <div key={group} className="mb-1">
              <SectionLabel>{group}</SectionLabel>
              {items.map((m) => (
                <MeetingRow
                  key={m.id}
                  meeting={m}
                  active={isActiveMeeting(m.id)}
                  recording={recordingMeetingId === m.id}
                  selected={selectedIds.has(m.id)}
                  onSelect={() => toggleSelect(m.id)}
                  contextItems={getMeetingContextItems(m)}
                  onClick={() => navigate({ to: "/meeting/$id", params: { id: m.id } })}
                />
              ))}
            </div>
          );
        })}

        {searchQuery && !hasVisibleMeetings && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "var(--glass-search-bg)" }}>
              <Search size={14} style={{ color: "var(--section-label-color)" }} />
            </div>
            <p className="text-caption" style={{ color: "var(--section-label-color)" }}>
              No meetings match <span className="font-medium" style={{ color: "var(--meeting-title-color)" }}>"{searchQuery}"</span>
            </p>
          </div>
        )}

        {!searchQuery && meetings.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "var(--glass-search-bg)", border: "1px solid var(--glass-search-border)" }}>
              <LayoutList size={16} style={{ color: "var(--section-label-color)" }} />
            </div>
            <div>
              <p className="text-caption font-medium" style={{ color: "var(--meeting-title-color)" }}>No meetings yet</p>
              <p className="text-caption mt-0.5" style={{ color: "var(--section-label-color)" }}>Start recording to capture your first meeting</p>
            </div>
            <button
              type="button"
              onClick={handleNewMeeting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-caption font-medium transition-colors"
              style={{ background: "rgba(var(--accent-rgb),0.15)", border: "1px solid rgba(var(--accent-rgb),0.25)", color: "var(--accent)" }}
            >
              <Plus size={13} />
              New Meeting
            </button>
          </div>
        )}
      </div>

      {/* Trash bin entry (user request): deleted meetings are recoverable —
          say so where deletion happens, not three levels into settings. */}
      {trashCount > 0 && (
        <button
          type="button"
          onClick={() => navigate({ to: "/settings", search: { section: "data" } })}
          className="shrink-0 flex items-center gap-2 px-3.5 py-2 text-left transition-colors hover:bg-bg-hover"
          style={{ borderTop: "1px solid var(--glass-header-border)", color: "var(--icon-color-dim)" }}
          title="Open the trash: restore or permanently delete"
        >
          <Trash2 size={12} className="shrink-0" />
          <span className="text-caption" style={{ color: "var(--meeting-meta-color)" }}>
            Trash · {trashCount}
          </span>
        </button>
      )}

      {confirmBulkDelete && (
        <ConfirmDialog
          open={true}
          title="Move to trash?"
          message={`${selectedIds.size} meeting${selectedIds.size !== 1 ? "s" : ""} will move to trash. You can restore them from Trash.`}
          confirmLabel="Move to Trash"
          variant="danger"
          onConfirm={handleBulkDelete}
          onCancel={() => setConfirmBulkDelete(false)}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <ConfirmDialog
          open={true}
          title="Delete meeting?"
          message={`"${deleteTarget.title}" will be moved to trash.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteMeeting}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </aside>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pt-2.5 pb-1 flex items-center gap-2">
      <span
        className="text-footnote font-semibold tracking-[0.08em] uppercase whitespace-nowrap"
        style={{ color: "var(--section-label-color)" }}
      >
        {children}
      </span>
      <div className="flex-1 h-px" style={{ background: "var(--glass-header-border)" }} />
    </div>
  );
}

function UpcomingEventRow({
  meeting, active, recording, selected, onSelect, contextItems, onClick,
}: {
  meeting: Meeting;
  active: boolean;
  recording: boolean;
  selected: boolean;
  onSelect: () => void;
  contextItems: ContextMenuItem[];
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isInteractive = hovered || focused;
  const showCheckbox = selected || isInteractive;

  const start = new Date(meeting.scheduled_start!);
  const end = meeting.scheduled_end ? new Date(meeting.scheduled_end) : null;
  const todayMeeting = isToday(start);
  const tomorrowMeeting = isTomorrow(start);
  const dayAbbr = todayMeeting ? "TODAY" : tomorrowMeeting ? "TMR" : format(start, "EEE").toUpperCase();
  const timeStr = format(start, "h:mm a");
  const durMins = end ? Math.round((end.getTime() - start.getTime()) / 60000) : null;
  const durStr = durMins && durMins >= 15
    ? durMins < 60 ? `${durMins}m` : `${Math.round(durMins / 60)}h`
    : null;

  return (
    <ContextMenu items={contextItems}>
      <div
        className="flex items-center gap-1.5 rounded-[10px] mb-1 select-none transition-all duration-100"
        style={{
          padding: "6px 7px",
          background: active
            ? "rgba(var(--accent-rgb), 0.12)"
            : isInteractive ? "var(--meeting-row-hover)" : "transparent",
          border: active
            ? "1px solid rgba(var(--accent-rgb), 0.22)"
            : "1px solid transparent",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <button
          type="button"
          tabIndex={-1}
          className="row-checkbox shrink-0 flex h-[18px] w-[16px] items-center justify-center rounded-[4px] transition-opacity"
          style={{
            ...(showCheckbox ? { opacity: 1 } : {}),
            background: selected ? "var(--accent)" : "transparent",
            boxShadow: selected
              ? "inset 0 0 0 1.5px var(--accent)"
              : "inset 0 0 0 1.5px var(--icon-color-dim)",
          }}
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          aria-label={selected ? `Deselect ${meeting.title}` : `Select ${meeting.title}`}
          aria-pressed={selected}
          title={selected ? "Deselect meeting" : "Select meeting"}
        >
          {selected && <Check size={9} style={{ color: "white" }} />}
        </button>

        <button
          type="button"
          data-roving-item
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-transparent text-left"
          onClick={() => { if (!consumeDragOccurred()) onClick(); }}
          onPointerDown={(e) => startPendingDrag(meeting.id, meeting.title, e.clientX, e.clientY)}
          onKeyDown={(e) => {
            if (e.key === " ") { e.preventDefault(); onSelect(); }
          }}
          aria-current={active ? "page" : undefined}
          aria-label={`Open ${meeting.title}${selected ? " (selected)" : ""}`}
        >
        {/* Date block */}
        <span
          className="shrink-0 w-[34px] rounded-[6px] flex flex-col items-center justify-center"
          style={{
            paddingTop: "4px",
            paddingBottom: "4px",
            background: todayMeeting
              ? "rgba(var(--accent-rgb), 0.18)"
              : "var(--glass-search-bg)",
          }}
        >
          <span
            className="text-[7.5px] font-bold tracking-wider uppercase leading-none"
            style={{ color: todayMeeting ? "var(--accent)" : "var(--section-label-color)" }}
          >
            {dayAbbr}
          </span>
          <span
            className="text-[15px] font-bold leading-none mt-[1px]"
            style={{ color: todayMeeting ? "var(--accent)" : "var(--meeting-title-color)" }}
          >
            {format(start, "d")}
          </span>
        </span>

        {/* Content */}
        <span className="flex-1 min-w-0">
          <span
            className="block text-caption font-medium truncate leading-tight mb-0.5"
            style={{ color: active ? "rgba(var(--accent-rgb), 0.95)" : "var(--meeting-title-color)" }}
          >
            {meeting.is_pinned && (
              <Pin size={9} className="mr-1 inline shrink-0" style={{ color: "var(--accent)" }} aria-label="Pinned" />
            )}
            {meeting.title}
          </span>
          <span
            className="block text-footnote"
            style={{ color: active ? "rgba(var(--accent-rgb), 0.65)" : "var(--meeting-meta-color)" }}
          >
            {timeStr}{durStr ? ` · ${durStr}` : ""}
          </span>
        </span>
        {recording && (
          <span
            className="w-[5px] h-[5px] rounded-full animate-pulse shrink-0"
            style={{ background: "rgba(var(--accent-rgb), 0.9)", boxShadow: "0 0 5px rgba(var(--accent-rgb),0.5)" }}
            aria-label="Recording"
          />
        )}
        </button>
      </div>
    </ContextMenu>
  );
}


function MeetingRow({
  meeting,
  active,
  recording,
  selected,
  onSelect,
  contextItems,
  onClick,
}: {
  meeting: Meeting;
  active: boolean;
  recording: boolean;
  selected: boolean;
  onSelect: () => void;
  contextItems: ContextMenuItem[];
  onClick: () => void;
}) {
  const timeLabel = getMeetingTimeLabel(meeting);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isInteractive = hovered || focused;
  const showCheckbox = selected || isInteractive;
  const meetingDate = getMeetingDate(meeting);
  const isUnprocessedToday = (meeting.note_status ?? "none") === "none" && !!meetingDate && isToday(meetingDate);

  return (
    <ContextMenu items={contextItems}>
      <div
        className="flex items-center rounded-[var(--radius-md)] mb-0.5 select-none transition-all duration-100"
        style={
          active
            ? {
                background: "rgba(var(--accent-rgb), 0.13)",
                border: "1px solid rgba(var(--accent-rgb), 0.22)",
                boxShadow: "inset 2.5px 0 0 var(--accent)",
                padding: "6px 8px",
              }
            : {
                background: isInteractive ? "var(--meeting-row-hover)" : isUnprocessedToday ? "var(--meeting-unprocessed-today-bg)" : "",
                border: "1px solid transparent",
                padding: "6px 8px",
              }
        }
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <button
          type="button"
          tabIndex={-1}
          className="row-checkbox mr-1.5 shrink-0 flex h-[18px] w-[16px] items-center justify-center rounded-[4px] transition-opacity"
          style={{
            ...(showCheckbox ? { opacity: 1 } : {}),
            background: selected ? "var(--accent)" : "transparent",
            boxShadow: selected
              ? "inset 0 0 0 1.5px var(--accent)"
              : "inset 0 0 0 1.5px var(--icon-color-dim)",
          }}
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          aria-label={selected ? `Deselect ${meeting.title}` : `Select ${meeting.title}`}
          aria-pressed={selected}
          title={selected ? "Deselect meeting" : "Select meeting"}
        >
          {selected && <Check size={9} style={{ color: "white" }} />}
        </button>

        <button
          type="button"
          data-roving-item
          className="flex min-w-0 flex-1 items-center rounded-md bg-transparent text-left"
          onClick={() => { if (!consumeDragOccurred()) onClick(); }}
          onPointerDown={(e) => startPendingDrag(meeting.id, meeting.title, e.clientX, e.clientY)}
          onKeyDown={(e) => {
            if (e.key === " ") { e.preventDefault(); onSelect(); }
          }}
          aria-current={active ? "page" : undefined}
          aria-label={`Open ${meeting.title}${selected ? " (selected)" : ""}`}
        >
        <span className="flex-1 min-w-0">
          <span
            className="block text-caption font-medium truncate leading-tight mb-0.5"
            style={{ color: active ? "rgba(var(--accent-rgb), 0.95)" : "var(--meeting-title-color)" }}
          >
            {meeting.is_pinned && (
              <Pin size={9} className="mr-1 inline shrink-0" style={{ color: "var(--accent)" }} aria-label="Pinned" />
            )}
            {meeting.title}
          </span>
          <span
            className="block text-footnote"
            style={{ color: active ? "rgba(var(--accent-rgb), 0.7)" : "var(--meeting-meta-color)" }}
          >
            {timeLabel}
            {meeting.actual_start && meeting.actual_end && (() => {
              const mins = Math.round((new Date(meeting.actual_end).getTime() - new Date(meeting.actual_start).getTime()) / 60000);
              return mins > 0 ? ` · ${mins}m` : null;
            })()}
          </span>
        </span>
        {/* Status badge */}
        <span className="shrink-0 ml-1.5 flex items-center gap-1.5">
          {recording && (
            <span
              className="w-[5px] h-[5px] rounded-full animate-pulse shrink-0"
              style={{ background: "rgba(var(--accent-rgb), 0.9)", boxShadow: "0 0 6px rgba(var(--accent-rgb),0.6)" }}
            />
          )}
          <MeetingStatusBadge status={meeting.note_status ?? "none"} />
        </span>
        </button>
      </div>
    </ContextMenu>
  );
}
