import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useNavigate, useMatchRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pin, Archive, Trash2, Search, FolderIcon,
  LayoutList, X, Check,
} from "lucide-react";
import { MeetingBanner } from "./MeetingBanner";
import { ipc, Meeting, Folder } from "../../lib/ipc";
import { format, isToday, isYesterday, isThisWeek, isTomorrow } from "date-fns";
import { ContextMenu, ContextMenuItem } from "../shared/ContextMenu";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { toast } from "../../stores/toastStore";
import { useRecordingStore } from "../../stores/recordingStore";
import { startPendingDrag, consumeDragOccurred } from "../../lib/meetingDrag";
import { MeetingStatusBadge } from "../shared/MeetingStatusBadge";

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
    await ipc.softDeleteMeeting(deleteTarget.id);
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.success(`"${deleteTarget.title}" moved to trash`);
    setDeleteTarget(null);
    navigate({ to: "/" });
  };

  const handleTogglePin = useCallback(async (meeting: Meeting) => {
    const pinned = await ipc.togglePinMeeting(meeting.id);
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.info(pinned ? "Meeting pinned" : "Meeting unpinned");
  }, [queryClient]);

  const handleArchive = useCallback(async (meeting: Meeting) => {
    await ipc.archiveMeeting(meeting.id);
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.info("Meeting archived");
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

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => ipc.softDeleteMeeting(id)));
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.success(`${ids.length} meeting${ids.length !== 1 ? "s" : ""} deleted`);
    clearSelection();
    navigate({ to: "/" });
  };

  const handleBulkArchive = async () => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => ipc.archiveMeeting(id)));
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.success(`${ids.length} meeting${ids.length !== 1 ? "s" : ""} archived`);
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

  const getMeetingContextItems = useCallback(
    (meeting: Meeting): ContextMenuItem[] => [
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
    ],
    [navigate, handleTogglePin, handleArchive],
  );

  // ─── Filtered + grouped data ───────────────────────────────────────────────

  const lowerSearch = searchQuery.toLowerCase();

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
          className="flex-1 text-[11px] font-semibold tracking-widest uppercase"
          style={{ color: "var(--panel-label-color)" }}
        >
          Meetings
        </span>
        <button
          type="button"
          onClick={handleNewMeeting}
          className="w-6 h-6 rounded-md flex items-center justify-center transition-colors"
          style={{ color: "var(--icon-color-dim)" }}
          title="New Meeting (⌘N)"
          aria-label="New Meeting"
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--icon-hover-bg)"; (e.currentTarget as HTMLElement).style.color = "var(--icon-color-bright)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; (e.currentTarget as HTMLElement).style.color = "var(--icon-color-dim)"; }}
        >
          <Plus size={13} />
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
            className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-text-muted"
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
              <span className="text-[11px] flex-1" style={{ color: "var(--icon-color-bright)" }}>
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
                <button type="button" onClick={handleBulkArchive} className="flex-1 text-[11px] py-0.5 rounded-md" style={{ background: "var(--icon-hover-bg)", color: "var(--icon-color-bright)" }}>Archive</button>
                <button type="button" onClick={() => setShowBulkFolderPicker(true)} className="flex-1 text-[11px] py-0.5 rounded-md" style={{ background: "var(--icon-hover-bg)", color: "var(--icon-color-bright)" }}>Move</button>
                <button type="button" onClick={handleBulkDelete} className="flex-1 text-[11px] py-0.5 rounded-md" style={{ background: "rgba(239,68,68,0.15)", color: "rgba(239,68,68,0.8)" }}>Delete</button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <button type="button" onClick={() => setShowBulkFolderPicker(false)} className="text-[11px]" style={{ color: "var(--accent)" }}>Back</button>
                <span className="text-[11px] flex-1 text-center" style={{ color: "var(--icon-color-dim)" }}>Move to folder</span>
              </div>
              {allFolders.length === 0 ? (
                <p className="px-2 py-1.5 text-[11px]" style={{ color: "var(--section-label-color)" }}>
                  No folders yet
                </p>
              ) : (
                allFolders.map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    onClick={() => handleBulkMoveToFolder(f.id)}
                    className="w-full text-left text-[11px] px-2 py-1 rounded-md flex items-center gap-2"
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
      <div className="flex-1 overflow-y-auto py-1.5 px-1.5">
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
            <p className="text-[11px]" style={{ color: "var(--section-label-color)" }}>
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
              <p className="text-[12px] font-medium" style={{ color: "var(--meeting-title-color)" }}>No meetings yet</p>
              <p className="text-[11px] mt-0.5" style={{ color: "var(--section-label-color)" }}>Start recording to capture your first meeting</p>
            </div>
            <button
              type="button"
              onClick={handleNewMeeting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
              style={{ background: "rgba(var(--accent-rgb),0.15)", border: "1px solid rgba(var(--accent-rgb),0.25)", color: "var(--accent)" }}
            >
              <Plus size={13} />
              New Meeting
            </button>
          </div>
        )}
      </div>

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
        className="text-[10px] font-semibold tracking-[0.08em] uppercase whitespace-nowrap"
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
          className="shrink-0 flex h-[18px] w-[16px] items-center justify-center rounded-[4px] transition-opacity"
          style={{
            opacity: showCheckbox ? 1 : 0.34,
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
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-transparent text-left"
          onClick={() => { if (!consumeDragOccurred()) onClick(); }}
          onPointerDown={(e) => startPendingDrag(meeting.id, meeting.title, e.clientX, e.clientY)}
          aria-current={active ? "page" : undefined}
          aria-label={`Open ${meeting.title}`}
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
            className="block text-[12px] font-medium truncate leading-tight mb-0.5"
            style={{ color: active ? "rgba(var(--accent-rgb), 0.95)" : "var(--meeting-title-color)" }}
          >
            {meeting.is_pinned && (
              <span className="mr-1" style={{ color: "var(--accent)" }}>·</span>
            )}
            {meeting.title}
          </span>
          <span
            className="block text-[10px]"
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
        className="flex items-center rounded-[9px] mb-0.5 select-none transition-all duration-100"
        style={
          active
            ? {
                background: "rgba(var(--accent-rgb), 0.13)",
                border: "1px solid rgba(var(--accent-rgb), 0.22)",
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
          className="mr-1.5 shrink-0 flex h-[18px] w-[16px] items-center justify-center rounded-[4px] transition-opacity"
          style={{
            opacity: showCheckbox ? 1 : 0.34,
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
          className="flex min-w-0 flex-1 items-center rounded-md bg-transparent text-left"
          onClick={() => { if (!consumeDragOccurred()) onClick(); }}
          onPointerDown={(e) => startPendingDrag(meeting.id, meeting.title, e.clientX, e.clientY)}
          aria-current={active ? "page" : undefined}
          aria-label={`Open ${meeting.title}`}
        >
        <span className="flex-1 min-w-0">
          <span
            className="block text-[12px] font-medium truncate leading-tight mb-0.5"
            style={{ color: active ? "rgba(var(--accent-rgb), 0.95)" : "var(--meeting-title-color)" }}
          >
            {meeting.is_pinned && (
              <span className="mr-1 text-[10px]" style={{ color: "var(--accent)" }}>·</span>
            )}
            {meeting.title}
          </span>
          <span
            className="block text-[10px]"
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
