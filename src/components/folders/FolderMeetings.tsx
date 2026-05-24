// src/components/folders/FolderMeetings.tsx
import { useMemo, useRef, useState, useEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format, isToday, isYesterday } from "date-fns";
import { LayoutList, Table, SlidersHorizontal, X, Check } from "lucide-react";
import { FolderNode, Meeting, ipc, openLocation, isLocationUrl } from "../../lib/ipc";
import { NoteCard } from "../notes/NoteCard";
import { useThemeStore, folderColorFromId } from "../../stores/themeStore";

interface FolderMeetingsProps {
  folder: FolderNode | null;
  onNavigate?: (folderId: string | null) => void;
}

type ColumnId = "date" | "time" | "duration" | "attendees" | "location" | "platform";

const ALL_COLUMNS: { id: ColumnId; label: string; width: string }[] = [
  { id: "date",      label: "Date",      width: "w-24" },
  { id: "time",      label: "Time",      width: "w-20" },
  { id: "duration",  label: "Dur",       width: "w-16" },
  { id: "attendees", label: "Attendees", width: "w-40" },
  { id: "location",  label: "Location",  width: "w-28" },
  { id: "platform",  label: "Platform",  width: "w-20" },
];

function getDateLabel(dateStr: string) {
  const d = new Date(dateStr);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEE, MMM d");
}

function groupByDate(meetings: Meeting[]) {
  const groups: { label: string; meetings: Meeting[] }[] = [];
  const seen = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const dateStr = m.scheduled_start || m.actual_start || m.created_at;
    const label = getDateLabel(dateStr);
    if (!seen.has(label)) { seen.set(label, []); groups.push({ label, meetings: seen.get(label)! }); }
    seen.get(label)!.push(m);
  }
  return groups;
}

function getDuration(m: Meeting): string {
  const start = m.actual_start || m.scheduled_start;
  const end = m.actual_end || m.scheduled_end;
  if (!start || !end) return "—";
  const mins = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  if (mins <= 0) return "—";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ""}`;
}

function getAttendeeList(m: Meeting): string {
  try {
    const arr = JSON.parse(m.attendees || "[]");
    if (!Array.isArray(arr) || arr.length === 0) return "—";
    const names = arr.slice(0, 3).map((a: { name?: string; email?: string }) => a.name || a.email || "").filter(Boolean);
    return names.join(", ") + (arr.length > 3 ? ` +${arr.length - 3}` : "");
  } catch { return "—"; }
}

function getColumnValue(m: Meeting, col: ColumnId): string {
  const dateStr = m.scheduled_start || m.actual_start || m.created_at;
  const d = dateStr ? new Date(dateStr) : null;
  switch (col) {
    case "date":      return d ? format(d, "MMM d, yyyy") : "—";
    case "time":      return d ? format(d, "h:mm a") : "—";
    case "duration":  return getDuration(m);
    case "attendees": return getAttendeeList(m);
    case "location":  return m.location || "—";
    case "platform":  return m.platform || "—";
  }
}

function SubfolderIcon({ node, color, onOpen }: { node: FolderNode; color: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="flex w-[80px] flex-col items-center gap-1 rounded-xl p-2 text-center transition-colors hover:bg-bg-hover focus-visible:bg-bg-hover"
      onClick={onOpen}
      title={`Open ${node.name}`}
      aria-label={`Open ${node.name} folder`}
    >
      <svg width="44" height="38" viewBox="0 0 56 48" fill="none">
        <rect x="0" y="10" width="56" height="38" rx="5" fill={color} opacity="0.85" />
        <path d="M0 10 Q0 6 4 6 L18 6 Q22 6 24 10 Z" fill={color} />
        <rect x="0" y="14" width="56" height="34" rx="5" fill={color} />
        <rect x="0" y="14" width="56" height="10" rx="5" fill="white" opacity="0.12" />
      </svg>
      <span className="text-[11px] text-text-secondary text-center leading-tight truncate w-full text-center">{node.name}</span>
      {node.meeting_count > 0 && (
        <span className="text-[9px] text-text-muted">{node.meeting_count}</span>
      )}
    </button>
  );
}

export function FolderMeetings({ folder, onNavigate }: FolderMeetingsProps) {
  const accentColor = useThemeStore(s => s.accentColor);
  const [activeDropId, setActiveDropId] = useState<string | null>(null);

  const { data: meetings = [] } = useQuery({
    queryKey: ["meetings", "folder", folder?.id],
    queryFn: () => ipc.getMeetingsInFolder(folder!.id),
    enabled: !!folder,
  });

  const { data: allFoldersList = [] } = useQuery({
    queryKey: ["folders"],
    queryFn: ipc.listFolders,
  });

  const folderMemberQueries = useQueries({
    queries: allFoldersList.map(f => ({
      queryKey: ["folderMeetings", f.id],
      queryFn: () => ipc.getMeetingIdsInFolder(f.id),
      staleTime: 5 * 60_000,
    })),
  });

  const meetingFolderIdsMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    allFoldersList.forEach((f, i) => {
      const ids = folderMemberQueries[i]?.data ?? [];
      ids.forEach(id => {
        if (!map[id]) map[id] = [];
        map[id].push(f.id);
      });
    });
    return map;
  }, [allFoldersList, folderMemberQueries]);

  const [viewMode, setViewMode] = useState<"cards" | "table">(() => {
    try { return (localStorage.getItem("folder-view-mode") as "cards" | "table") ?? "table"; }
    catch { return "table"; }
  });
  useEffect(() => { localStorage.setItem("folder-view-mode", viewMode); }, [viewMode]);

  const [activeColumns, setActiveColumns] = useState<ColumnId[]>(() => {
    try {
      const s = localStorage.getItem("folder-table-columns");
      if (s) return JSON.parse(s);
    } catch {}
    return ["date", "duration", "attendees"];
  });
  useEffect(() => { localStorage.setItem("folder-table-columns", JSON.stringify(activeColumns)); }, [activeColumns]);

  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const columnPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showColumnPicker) return;
    const handler = (e: MouseEvent) => {
      if (columnPickerRef.current && !columnPickerRef.current.contains(e.target as Node)) {
        setShowColumnPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showColumnPicker]);

  useEffect(() => {
    const handler = (event: Event) => {
      const folderId = (event as CustomEvent<{ folderId: string | null }>).detail?.folderId ?? null;
      setActiveDropId(folderId);
    };
    document.addEventListener("meeting-drag-over", handler);
    return () => document.removeEventListener("meeting-drag-over", handler);
  }, []);

  if (!folder) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-sm">
        Select a folder to see its meetings.
      </div>
    );
  }

  const grouped = groupByDate(meetings);
  const isDropTarget = activeDropId === folder.id;

  return (
    <div
      className={`h-full flex flex-col overflow-hidden transition-shadow ${isDropTarget ? "ring-1 ring-inset ring-accent/60" : ""}`}
      data-folder-drop={folder.id}
    >
      {/* Toolbar */}
      <div className="px-3 py-2 border-b border-border shrink-0 flex items-center justify-end gap-1 relative z-20">
        {/* Column picker — only in table mode */}
        {viewMode === "table" && (
          <div className="relative" ref={columnPickerRef}>
            <button
              type="button"
              onClick={() => setShowColumnPicker(v => !v)}
              className={`icon-btn ${showColumnPicker ? "text-accent bg-accent/8 border-accent/40" : ""}`}
              title="Choose columns"
              aria-label="Choose columns"
              aria-expanded={showColumnPicker}
            >
              <SlidersHorizontal size={13} />
            </button>
            {showColumnPicker && (
              <div className="absolute right-0 top-full mt-1 w-40 border rounded-lg shadow-xl z-50 py-1" style={{ background: "var(--popup-bg)", borderColor: "var(--popup-border)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
                {ALL_COLUMNS.map(col => {
                  const active = activeColumns.includes(col.id);
                  return (
                    <button
                      type="button"
                      key={col.id}
                      onClick={() => setActiveColumns(prev =>
                        active ? prev.filter(id => id !== col.id) : [...prev, col.id]
                      )}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-hover transition-colors"
                    >
                      <span className={`flex-1 text-left ${active ? "text-text-primary" : "text-text-secondary"}`}>{col.label}</span>
                      {active && <Check size={10} className="text-accent shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* View toggle */}
        <button
          type="button"
          onClick={() => setViewMode(v => v === "cards" ? "table" : "cards")}
          className={`icon-btn ${viewMode === "table" ? "text-accent bg-accent/8 border-accent/40" : ""}`}
          title={viewMode === "cards" ? "Switch to table view" : "Switch to card view"}
          aria-label={viewMode === "cards" ? "Switch to table view" : "Switch to card view"}
        >
          {viewMode === "cards" ? <Table size={13} /> : <LayoutList size={13} />}
        </button>
      </div>

      {/* Subfolder icon grid */}
      {folder.children.length > 0 && (
        <div className="px-4 pt-3 pb-2 border-b border-border shrink-0">
          <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-2">Folders</p>
          <div className="flex flex-wrap gap-1">
            {folder.children.map(child => (
              <SubfolderIcon
                key={child.id}
                node={child}
                color={folderColorFromId(child.id, accentColor)}
                onOpen={() => onNavigate ? onNavigate(child.id) : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* Meeting list */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {isDropTarget && (
          <div className="mx-4 mt-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-medium text-accent" role="status">
            Release to move meeting into {folder.name}
          </div>
        )}
        {meetings.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-1 text-text-muted">
            <p className="text-sm">No meetings in this folder yet.</p>
            <p className="text-[12px]">Drag meetings here or right-click a meeting to move it.</p>
          </div>
        ) : viewMode === "table" ? (
          /* Table — single scroll container */
          <div className="flex-1 overflow-auto">
            {/* Sticky header */}
            <div className="flex items-center bg-bg-secondary border-b border-border text-[10px] font-semibold text-text-muted uppercase tracking-wider sticky top-0 z-10" style={{ minWidth: "max-content" }}>
              <div className="w-[200px] px-3 py-2 shrink-0">Title</div>
              {ALL_COLUMNS.filter(c => activeColumns.includes(c.id)).map(col => (
                <div key={col.id} className={`${col.width} px-2.5 py-2 flex items-center gap-1 group shrink-0`}>
                  {col.label}
                  <button
                    type="button"
                    onClick={() => setActiveColumns(prev => prev.filter(id => id !== col.id))}
                    className="ml-auto rounded text-text-muted opacity-0 transition-opacity hover:text-text-primary focus:opacity-100 group-hover:opacity-60 group-focus-within:opacity-60"
                    title={`Remove ${col.label}`}
                    aria-label={`Remove ${col.label} column`}
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
            {/* Rows */}
            <div style={{ minWidth: "max-content" }}>
              {meetings.map(m => (
                <Link
                  key={m.id}
                  to="/meeting/$id"
                  params={{ id: m.id }}
                  className="flex items-center border-b border-border/40 last:border-0 hover:bg-bg-hover transition-colors group"
                >
                  <div className="w-[200px] px-3 py-2.5 text-[12px] font-medium text-text-primary line-clamp-2 leading-snug shrink-0">{m.title}</div>
                  {ALL_COLUMNS.filter(c => activeColumns.includes(c.id)).map(col => (
                    <div key={col.id} className={`${col.width} px-2.5 py-2.5 text-[11px] text-text-secondary truncate shrink-0`}>
                      {col.id === "location" && m.location ? (
                        <button
                          type="button"
                          onClick={e => { e.preventDefault(); e.stopPropagation(); openLocation(m.location!); }}
                          className="text-accent/70 hover:text-accent transition-colors truncate max-w-full text-left"
                          title={isLocationUrl(m.location) ? m.location : `Open in Maps: ${m.location}`}
                        >
                          {m.location}
                        </button>
                      ) : (
                        getColumnValue(m, col.id)
                      )}
                    </div>
                  ))}
                </Link>
              ))}
            </div>
          </div>
        ) : (
          /* Card view */
          <div className="flex-1 overflow-y-auto py-2">
            {grouped.map(group => (
              <div key={group.label} className="mb-4">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider px-4 py-1.5">
                  {group.label}
                </p>
                {group.meetings.map(m => (
                  <NoteCard
                    key={m.id}
                    meeting={m}
                    currentFolderId={folder.id}
                    meetingFolderIds={meetingFolderIdsMap[m.id] || [folder.id]}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
