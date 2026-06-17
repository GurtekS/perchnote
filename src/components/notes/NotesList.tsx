import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, isToday, isYesterday, isTomorrow } from "date-fns";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDownUp, CalendarX, Search as SearchIcon, LayoutList, Table as TableIcon, SlidersHorizontal, Tag as TagIcon, X, Check } from "lucide-react";
import { ipc, Meeting, Folder, SearchResult, openLocation, isLocationUrl } from "../../lib/ipc";
import { NoteCard } from "./NoteCard";
import { SearchBar } from "./SearchBar";
import { MeetingCardSkeleton } from "../shared/Skeleton";

interface NotesListProps {
  /** Exact tag name from the /meetings `tag` search param (tags read path). */
  initialTag?: string;
}

type ColumnId = "date" | "time" | "duration" | "attendees" | "location" | "folder" | "platform";
/** "title" is the fixed leading column; the rest are user-toggleable. Both
 *  are resizable, so widths are keyed by this union. */
type WidthKey = ColumnId | "title";

const ALL_COLUMNS: { id: ColumnId; label: string; defaultWidth: number }[] = [
  { id: "date", label: "Date", defaultWidth: 96 },
  { id: "time", label: "Time", defaultWidth: 80 },
  { id: "duration", label: "Dur", defaultWidth: 64 },
  { id: "attendees", label: "Attendees", defaultWidth: 160 },
  { id: "location", label: "Location", defaultWidth: 112 },
  { id: "folder", label: "Folder", defaultWidth: 96 },
  { id: "platform", label: "Platform", defaultWidth: 80 },
];

const TITLE_DEFAULT_WIDTH = 200;
const MIN_COLUMN_WIDTH = 56;
/** Default px width for any resizable column, by key. */
const DEFAULT_WIDTHS: Record<WidthKey, number> = {
  title: TITLE_DEFAULT_WIDTH,
  ...Object.fromEntries(ALL_COLUMNS.map((c) => [c.id, c.defaultWidth])),
} as Record<WidthKey, number>;

type SortOption = "newest" | "oldest" | "title" | "duration";

const sortLabels: { value: SortOption; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "title", label: "Title A–Z" },
  { value: "duration", label: "Longest" },
];

function getDayLabel(dateStr: string): string {
  const d = new Date(dateStr);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  if (isTomorrow(d)) return "Tomorrow";
  return format(d, "EEE, MMM d");
}

export function NotesList({ initialTag }: NotesListProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(initialTag ?? null);
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [viewMode, setViewMode] = useState<"cards" | "table">(() => {
    try { return (localStorage.getItem("notes-view-mode") as "cards" | "table") ?? "cards"; }
    catch { return "cards"; }
  });
  useEffect(() => { localStorage.setItem("notes-view-mode", viewMode); }, [viewMode]);

  const [activeColumns, setActiveColumns] = useState<ColumnId[]>(() => {
    try {
      const saved = localStorage.getItem("notes-table-columns");
      if (saved) return JSON.parse(saved);
    } catch {}
    return ["date", "duration", "attendees", "folder"];
  });
  useEffect(() => {
    localStorage.setItem("notes-table-columns", JSON.stringify(activeColumns));
  }, [activeColumns]);
  // Per-column widths (px), drag-resizable from each header's right edge and
  // persisted like the column selection. Unknown/legacy keys fall back to the
  // defaults so adding a column later can't read as 0-width.
  const [columnWidths, setColumnWidths] = useState<Record<WidthKey, number>>(() => {
    try {
      const saved = localStorage.getItem("notes-table-widths");
      if (saved) return { ...DEFAULT_WIDTHS, ...JSON.parse(saved) };
    } catch {}
    return { ...DEFAULT_WIDTHS };
  });
  useEffect(() => {
    localStorage.setItem("notes-table-widths", JSON.stringify(columnWidths));
  }, [columnWidths]);

  // Active drag — captured on the handle so moves track even past the cell.
  const resizeRef = useRef<{ key: WidthKey; startX: number; startWidth: number } | null>(null);
  const widthOf = (key: WidthKey) => columnWidths[key] ?? DEFAULT_WIDTHS[key];
  const setWidth = useCallback((key: WidthKey, px: number) => {
    setColumnWidths((prev) => ({ ...prev, [key]: Math.max(MIN_COLUMN_WIDTH, Math.round(px)) }));
  }, []);
  const onResizeDown = (key: WidthKey) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { key, startX: e.clientX, startWidth: widthOf(key) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    setWidth(r.key, r.startWidth + (e.clientX - r.startX));
  };
  const onResizeUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!resizeRef.current) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    resizeRef.current = null;
  };

  // A thin grip on the cell's right edge. Keyboard-resizable (the a11y track
  // keeps every control reachable); double-click resets the column.
  const renderResizer = (key: WidthKey, label: string) => (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onResizeDown(key)}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeUp}
      onDoubleClick={() => setWidth(key, DEFAULT_WIDTHS[key])}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          setWidth(key, widthOf(key) + (e.key === "ArrowLeft" ? -16 : 16));
        }
      }}
      className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/60"
    />
  );

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
    setTagFilter(initialTag ?? null);
  }, [initialTag]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value.trim());
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (!showSortMenu) return;
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setShowSortMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSortMenu]);

  const { data: meetings = [], isLoading: meetingsLoading } = useQuery({
    queryKey: ["meetings"],
    queryFn: ipc.listMeetings,
  });

  const { data: folders = [] } = useQuery<Folder[]>({
    queryKey: ["folders"],
    queryFn: ipc.listFolders,
    staleTime: 5 * 60_000,
  });

  // One round-trip for the whole meeting→folders map (was one query per
  // folder — plan rank 9). Key invalidated alongside "folderMeetings".
  const { data: folderMembershipsData } = useQuery<Record<string, string[]>>({
    queryKey: ["folderMembershipsMap"],
    queryFn: ipc.getFolderMembershipsMap,
    staleTime: 5 * 60_000,
  });
  // `?? {}` not a destructure default: a null payload must not crash entries().
  const folderMemberships = folderMembershipsData ?? {};

  const meetingFolderMap = useMemo(() => {
    const map: Record<string, Folder> = {};
    // Same precedence as before: later folders in list order win.
    for (const folder of folders) {
      for (const [meetingId, folderIds] of Object.entries(folderMemberships)) {
        if (folderIds.includes(folder.id)) map[meetingId] = folder;
      }
    }
    return map;
  }, [folders, folderMemberships]);

  const meetingFolderIdsMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const [meetingId, folderIds] of Object.entries(folderMemberships)) {
      map[meetingId] = [...folderIds];
    }
    return map;
  }, [folderMemberships]);

  // Keyword + semantic recall in ONE round-trip, fused server-side with
  // rrf_fuse at meeting level (plan v9 #10 — replaces the searchAll +
  // semanticSearch pair merged client-side). Meetings only meaning-search
  // found ("how much can we spend" → the budget discussion) arrive as one
  // match_source "semantic" row ("Related:"), still carrying match_start_ms
  // for click-to-seek (plan v8 A4). With embeddings off the payload is
  // exactly searchAll's, so this stays invisible until semantic recall is on.
  const { data: searchResults } = useQuery({
    queryKey: ["searchWithSemantic", debouncedSearch],
    queryFn: () => ipc.searchWithSemantic(debouncedSearch, 50),
    enabled: debouncedSearch.length >= 2,
    staleTime: 30_000,
  });

  const meetingIds = useMemo(
    () => meetings.map((m: { id: string }) => m.id),
    [meetings]
  );
  const { data: meetingTagsMap = {} } = useQuery({
    queryKey: ["meetingTags", meetingIds],
    queryFn: async () => {
      const tagsByMeeting = await ipc.getTagsForMeetings(meetingIds);
      const map: Record<string, string[]> = {};
      for (const [id, tags] of Object.entries(tagsByMeeting)) {
        map[id] = tags.map((t) => t.name);
      }
      return map;
    },
    enabled: meetingIds.length > 0,
  });

  // Best row per meeting for the card subline. Rows arrive grouped by
  // meeting in fused order, so first-wins preserves search_all's arm
  // precedence (title, then transcript, then notes) and "semantic" rows
  // only exist for meetings keyword search missed.
  const searchResultMap = useMemo(() => {
    const map: Record<string, SearchResult> = {};
    for (const r of searchResults ?? []) {
      if (!map[r.meeting_id]) map[r.meeting_id] = r;
    }
    return map;
  }, [searchResults]);

  // Upcoming meetings (future, not yet started)
  const upcomingMeetings = useMemo(() => {
    const now = new Date();
    return meetings
      .filter(
        (m: Meeting) =>
          m.status === "upcoming" &&
          m.scheduled_start &&
          new Date(m.scheduled_start) > now
      )
      .sort((a: Meeting, b: Meeting) => {
        const da = a.scheduled_start || "";
        const db = b.scheduled_start || "";
        return da.localeCompare(db);
      })
      .slice(0, 4);
  }, [meetings]);

  const filtered = useMemo(() => {
    let list = meetings.filter((m: Meeting) => m.status !== "upcoming");

    if (debouncedSearch.length >= 2 && searchResults) {
      // Fused results already include the semantic-only meetings.
      const matchedIds = new Set(searchResults.map((r: SearchResult) => r.meeting_id));
      list = list.filter((m: { id: string }) => matchedIds.has(m.id));
    } else if (search) {
      list = list.filter((m: { title: string }) =>
        m.title.toLowerCase().includes(search.toLowerCase())
      );
    }

    // Tags read path (discoverability batch): exact tag-name match, set by
    // the /meetings?tag= param and removable via the header chip.
    if (tagFilter) {
      list = list.filter((m: { id: string }) => (meetingTagsMap[m.id] ?? []).includes(tagFilter));
    }

    return [...list].sort((a, b) => {
      switch (sortBy) {
        case "oldest": {
          const da = a.scheduled_start || a.created_at || "";
          const db = b.scheduled_start || b.created_at || "";
          return da.localeCompare(db);
        }
        case "title":
          return (a.title ?? "").localeCompare(b.title ?? "");
        case "duration": {
          const durA =
            a.actual_start && a.actual_end
              ? new Date(a.actual_end).getTime() - new Date(a.actual_start).getTime()
              : 0;
          const durB =
            b.actual_start && b.actual_end
              ? new Date(b.actual_end).getTime() - new Date(b.actual_start).getTime()
              : 0;
          return durB - durA;
        }
        case "newest":
        default: {
          const da = a.scheduled_start || a.created_at || "";
          const db = b.scheduled_start || b.created_at || "";
          return db.localeCompare(da);
        }
      }
    });
  }, [meetings, search, debouncedSearch, searchResults, tagFilter, meetingTagsMap, sortBy]);

  // Group past meetings by day
  const grouped = useMemo(() => {
    const groups: Array<{ label: string; meetings: Meeting[] }> = [];
    const labelMap = new Map<string, Meeting[]>();
    for (const m of filtered) {
      const dateStr = m.scheduled_start || m.actual_start || m.created_at;
      if (!dateStr) continue;
      const label = getDayLabel(dateStr);
      if (!labelMap.has(label)) {
        labelMap.set(label, []);
        groups.push({ label, meetings: labelMap.get(label)! });
      }
      labelMap.get(label)!.push(m);
    }
    return groups;
  }, [filtered]);

  // ONE round-trip for every preview line. The old useQueries fan-out made
  // a per-meeting IPC call returning both full note bodies — the entire
  // notes corpus crossed the bridge on every home visit (lifetime #18).
  const { data: notePreviews } = useQuery({
    queryKey: ["note-previews"],
    queryFn: ipc.listNotePreviews,
    // One cheap call per home visit keeps previews honest after edits
    // (QA audit finding 7: nothing invalidates this key on note saves).
    refetchOnMount: "always",
  });

  const meetingNotePreviewMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of notePreviews ?? []) {
      map[p.meeting_id] = p.preview;
    }
    return map;
  }, [notePreviews]);

  const isSearchActive = debouncedSearch.length >= 2;

  function getDuration(m: Meeting): string {
    if (m.actual_start && m.actual_end) {
      const mins = Math.round((new Date(m.actual_end).getTime() - new Date(m.actual_start).getTime()) / 60000);
      if (mins <= 0) return "–";
      if (mins < 60) return `${mins}m`;
      return `${Math.floor(mins / 60)}h ${mins % 60 > 0 ? `${mins % 60}m` : ""}`.trim();
    }
    if (m.scheduled_start && m.scheduled_end) {
      const mins = Math.round((new Date(m.scheduled_end).getTime() - new Date(m.scheduled_start).getTime()) / 60000);
      if (mins < 60) return `${mins}m`;
      return `${Math.floor(mins / 60)}h ${mins % 60 > 0 ? `${mins % 60}m` : ""}`.trim();
    }
    return "–";
  }

  function getAttendeeList(m: Meeting): string {
    try {
      const arr = JSON.parse(m.attendees || "[]");
      if (!Array.isArray(arr) || arr.length === 0) return "–";
      return arr.slice(0, 3).map((a: { name?: string; email?: string }) => a.name || a.email || "").filter(Boolean).join(", ") + (arr.length > 3 ? ` +${arr.length - 3}` : "");
    } catch { return "–"; }
  }

  function getColumnValue(m: Meeting, col: ColumnId, folderMap: Record<string, Folder>): string {
    const dateStr = m.scheduled_start || m.actual_start || m.created_at;
    const d = dateStr ? new Date(dateStr) : null;
    switch (col) {
      case "date": return d ? format(d, "MMM d, yyyy") : "–";
      case "time": return d ? format(d, "h:mm a") : "–";
      case "duration": return getDuration(m);
      case "attendees": return getAttendeeList(m);
      case "location": return m.location || "–";
      case "folder": return folderMap[m.id]?.name || "–";
      case "platform": return m.platform || "–";
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 pt-4 pb-2 shrink-0 bg-bg-primary border-b border-border/60 relative z-20">
        {/* Search + sort row */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 min-w-0">
            <SearchBar value={search} onChange={handleSearchChange} />
          </div>

          {/* Icon-only action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            {/* View toggle */}
            <button
              type="button"
              onClick={() => setViewMode(v => v === "cards" ? "table" : "cards")}
              className={`icon-btn ${viewMode === "table" ? "text-accent bg-accent/8 border-accent/40" : ""}`}
              title={viewMode === "cards" ? "Switch to table view" : "Switch to card view"}
              aria-label={viewMode === "cards" ? "Switch to table view" : "Switch to card view"}
            >
              {viewMode === "cards" ? <TableIcon size={13} /> : <LayoutList size={13} />}
            </button>

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
                  <div className="glass-float absolute right-0 top-full mt-1 w-40 rounded-lg z-50 py-1">
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

            {/* Sort */}
            <div className="relative" ref={sortMenuRef}>
              <button
                type="button"
                onClick={() => setShowSortMenu(v => !v)}
                className={`icon-btn relative ${sortBy !== "newest" ? "text-accent bg-accent/8 border-accent/40" : ""}`}
                title={`Sort: ${sortLabels.find(s => s.value === sortBy)?.label}`}
                aria-label={`Sort meetings, currently ${sortLabels.find(s => s.value === sortBy)?.label}`}
                aria-expanded={showSortMenu}
              >
                <ArrowDownUp size={13} />
                {sortBy !== "newest" && (
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />
                )}
              </button>
              {showSortMenu && (
                <div className="glass-float menu-dropdown absolute right-0 top-full mt-1 w-36 rounded-lg z-50 py-1">
                  {sortLabels.map((s) => (
                    <button
                      type="button"
                      key={s.value}
                      onClick={() => { setSortBy(s.value); setShowSortMenu(false); }}
                      className={`w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors ${
                        sortBy === s.value
                          ? "text-accent font-medium"
                          : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                      }`}
                    >
                      {s.label}
                      {sortBy === s.value && <Check size={10} className="text-accent" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Active tag filter — removable here, set by tag chips elsewhere */}
        {tagFilter && (
          <div className="mt-2 flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-footnote text-text-secondary">
              <TagIcon size={9} className="shrink-0" />
              {tagFilter}
              <button
                type="button"
                onClick={() => {
                  setTagFilter(null);
                  navigate({ to: "/meetings", search: {} });
                }}
                className="ml-0.5 rounded text-text-muted hover:text-text-primary transition-colors"
                title="Remove tag filter"
                aria-label={`Stop filtering by tag ${tagFilter}`}
              >
                <X size={10} />
              </button>
            </span>
          </div>
        )}
        {isSearchActive && searchResults && (() => {
          // Fused results carry up to one row per arm per meeting (A3 v2)
          // plus one "semantic" row per keyword-missed meeting; this list
          // shows meetings, so count those.
          const n = new Set(searchResults.map((r: SearchResult) => r.meeting_id)).size;
          return (
            <p className="text-caption text-text-muted mt-2">
              {n} meeting{n !== 1 ? "s" : ""}
            </p>
          );
        })()}
      </div>

      {/* Content area — flex-1 so it fills remaining height */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {meetingsLoading ? (
          <div className="overflow-y-auto flex-1 px-4 pt-2 pb-6 space-y-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <MeetingCardSkeleton key={i} />
            ))}
          </div>
        ) : filtered.length === 0 && (!!tagFilter || upcomingMeetings.length === 0) ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
            <div className="empty-state-icon">
              {search || tagFilter ? <SearchIcon size={18} /> : <CalendarX size={18} />}
            </div>
            <p className="text-sm font-medium text-text-secondary">
              {search || tagFilter ? "No matching meetings" : "No meetings yet"}
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              {search
                ? "Try a different search term"
                : tagFilter
                ? `No meetings tagged \u201c${tagFilter}\u201d`
                : "Press \u2318N to start your first meeting"}
            </p>
            {/* First-five-minutes value (plan v10 #6): the import pipeline
                makes a real transcribed meeting out of any recording the
                user already has \u2014 say so where the emptiness is felt. */}
            {!search && !tagFilter && (
              <p className="text-xs text-text-muted">
                or drop an audio file here \u2014 a Voice Memo, a call recording \u2014
                and it becomes a transcribed meeting
              </p>
            )}
            {!search && !tagFilter && (
              <button
                onClick={async () => {
                  try {
                    const m = await ipc.createMeeting("Untitled Meeting");
                    queryClient.invalidateQueries({ queryKey: ["meetings"] });
                    navigate({ to: "/meeting/$id", params: { id: m.id } });
                  } catch { /* ignore */ }
                }}
                className="mt-4 px-4 py-2 rounded-lg text-xs border border-dashed border-border text-text-muted hover:text-text-secondary hover:border-accent/40 transition-colors"
              >
                Create your first meeting
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Coming up — pinned above scroll area, card view only */}
            {!isSearchActive && !tagFilter && upcomingMeetings.length > 0 && viewMode === "cards" && (
              <div className="shrink-0 px-4 pt-2 pb-3 border-b border-border/50">
                <p className="text-caption font-semibold text-text-muted uppercase tracking-wider pb-1.5">
                  Coming up
                </p>
                <div className="space-y-1">
                  {upcomingMeetings.map((m) => {
                    const d = new Date(m.scheduled_start!);
                    const end = m.scheduled_end ? new Date(m.scheduled_end) : null;
                    return (
                      <Link
                        key={m.id}
                        to="/meeting/$id"
                        params={{ id: m.id }}
                        className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-bg-secondary border border-border hover:border-accent/30 hover:bg-bg-hover transition-all"
                      >
                        <div className="text-center shrink-0 w-9">
                          <div className="text-xl font-bold text-text-primary leading-none">{format(d, "d")}</div>
                          <div className="text-[9px] uppercase tracking-wide text-text-muted mt-0.5">{format(d, "MMM")}</div>
                          <div className="text-[9px] text-text-muted">{format(d, "EEE")}</div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-body-sm font-medium text-text-primary truncate">{m.title}</p>
                          <p className="text-caption text-text-muted mt-0.5">
                            {format(d, "h:mm a")}{end ? ` – ${format(end, "h:mm a")}` : ""}
                          </p>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            {viewMode === "table" ? (
              /* Table — single overflow-auto handles both scroll axes */
              <div className="flex-1 overflow-auto">
                {/* Sticky header */}
                <div className="flex items-center bg-bg-secondary border-b border-border text-footnote font-semibold text-text-muted uppercase tracking-wider sticky top-0 z-10" style={{ minWidth: "max-content" }}>
                  <div className="relative px-3 py-2 shrink-0" style={{ width: widthOf("title") }}>
                    Title
                    {renderResizer("title", "Title")}
                  </div>
                  {ALL_COLUMNS.filter(c => activeColumns.includes(c.id)).map(col => (
                    <div key={col.id} className="relative px-2.5 py-2 flex items-center gap-1 group shrink-0" style={{ width: widthOf(col.id) }}>
                      <span className="truncate">{col.label}</span>
                      <button
                        type="button"
                        onClick={() => setActiveColumns(prev => prev.filter(id => id !== col.id))}
                        className="ml-auto mr-1.5 rounded text-text-muted opacity-0 transition-opacity hover:text-text-primary focus:opacity-100 group-hover:opacity-60 group-focus-within:opacity-60"
                        title={`Remove ${col.label}`}
                        aria-label={`Remove ${col.label} column`}
                      >
                        <X size={9} />
                      </button>
                      {renderResizer(col.id, col.label)}
                    </div>
                  ))}
                </div>
                {/* Rows */}
                <div style={{ minWidth: "max-content" }}>
                  {filtered.map(m => (
                    <Link
                      key={m.id}
                      to="/meeting/$id"
                      params={{ id: m.id }}
                      className="flex items-center border-b border-border/40 last:border-0 hover:bg-bg-hover transition-colors group"
                    >
                      <div className="px-3 py-2.5 text-caption font-medium text-text-primary line-clamp-2 leading-snug shrink-0" style={{ width: widthOf("title") }}>{m.title}</div>
                      {ALL_COLUMNS.filter(c => activeColumns.includes(c.id)).map(col => (
                        <div key={col.id} className="px-2.5 py-2.5 text-caption text-text-secondary truncate shrink-0" style={{ width: widthOf(col.id) }}>
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
                            getColumnValue(m, col.id, meetingFolderMap)
                          )}
                        </div>
                      ))}
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              /* Card view — vertical scroll only */
              <div className="flex-1 overflow-y-auto px-2 pb-6">
                {grouped.map((group) => (
                  <div key={group.label} className="mb-4">
                    <p className="text-caption font-semibold text-text-muted uppercase tracking-wider px-4 py-1.5">
                      {group.label}
                    </p>
                    <div>
                      {group.meetings.map((m, i) => (
                        <div key={m.id} className="animate-fade-in" style={{ animationDelay: `${i * 20}ms` }}>
                          <NoteCard
                            meeting={m}
                            tags={meetingTagsMap[m.id] || []}
                            searchMatch={searchResultMap[m.id]}
                            folder={meetingFolderMap[m.id] ?? null}
                            notePreview={meetingNotePreviewMap[m.id]}
                            meetingFolderIds={meetingFolderIdsMap[m.id] || []}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
