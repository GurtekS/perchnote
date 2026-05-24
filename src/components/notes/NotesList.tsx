import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { format, isToday, isYesterday, isTomorrow } from "date-fns";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDownUp, CalendarX, Search as SearchIcon, LayoutList, Table as TableIcon, SlidersHorizontal, X, Check } from "lucide-react";
import { ipc, Meeting, Folder, SearchResult, openLocation, isLocationUrl } from "../../lib/ipc";

/** Extract plain text from TipTap JSON, up to maxChars characters. */
function extractPlainText(rawContent: string, maxChars = 140): string {
  try {
    const doc = JSON.parse(rawContent);
    const parts: string[] = [];

    function traverse(node: Record<string, unknown>) {
      if (node.type === "text" && typeof node.text === "string") {
        parts.push(node.text);
        return;
      }
      const children = node.content as Array<Record<string, unknown>> | undefined;
      if (children) {
        for (const child of children) {
          traverse(child);
        }
        if (["paragraph", "heading", "blockquote"].includes(node.type as string)) {
          parts.push(" ");
        }
      }
    }

    traverse(doc);
    const text = parts.join("").replace(/\s+/g, " ").trim();
    return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  } catch {
    return "";
  }
}

import { NoteCard } from "./NoteCard";
import { SearchBar } from "./SearchBar";
import { MeetingCardSkeleton } from "../shared/Skeleton";

interface NotesListProps {
  initialFolder?: string;
}

type ColumnId = "date" | "time" | "duration" | "attendees" | "location" | "folder" | "platform";

const ALL_COLUMNS: { id: ColumnId; label: string; width: string }[] = [
  { id: "date", label: "Date", width: "w-24" },
  { id: "time", label: "Time", width: "w-20" },
  { id: "duration", label: "Dur", width: "w-16" },
  { id: "attendees", label: "Attendees", width: "w-40" },
  { id: "location", label: "Location", width: "w-28" },
  { id: "folder", label: "Folder", width: "w-24" },
  { id: "platform", label: "Platform", width: "w-20" },
];

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

export function NotesList({ initialFolder }: NotesListProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(initialFolder ?? null);
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
    setSelectedFolder(initialFolder ?? null);
  }, [initialFolder]);

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

  const { data: folderMeetingIds } = useQuery({
    queryKey: ["folderMeetings", selectedFolder],
    queryFn: () => ipc.getMeetingIdsInFolder(selectedFolder!),
    enabled: !!selectedFolder,
  });

  const { data: folders = [] } = useQuery<Folder[]>({
    queryKey: ["folders"],
    queryFn: ipc.listFolders,
    staleTime: 5 * 60_000,
  });

  const folderMemberQueries = useQueries({
    queries: folders.map((f) => ({
      queryKey: ["folderMeetings", f.id],
      queryFn: () => ipc.getMeetingIdsInFolder(f.id),
      staleTime: 5 * 60_000,
    })),
  });

  const meetingFolderMap = useMemo(() => {
    const map: Record<string, Folder> = {};
    folders.forEach((folder, i) => {
      const ids = folderMemberQueries[i]?.data ?? [];
      ids.forEach((id) => { map[id] = folder; });
    });
    return map;
  }, [folders, folderMemberQueries]);

  const meetingFolderIdsMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    folders.forEach((folder, i) => {
      const ids = folderMemberQueries[i]?.data ?? [];
      ids.forEach(id => {
        if (!map[id]) map[id] = [];
        map[id].push(folder.id);
      });
    });
    return map;
  }, [folders, folderMemberQueries]);

  const { data: searchResults } = useQuery({
    queryKey: ["searchAll", debouncedSearch],
    queryFn: () => ipc.searchAll(debouncedSearch, 50),
    enabled: debouncedSearch.length >= 2,
  });

  const { data: meetingTagsMap = {} } = useQuery({
    queryKey: ["meetingTags", meetings.map((m: { id: string }) => m.id).join(",")],
    queryFn: async () => {
      const map: Record<string, string[]> = {};
      await Promise.all(
        meetings.map(async (m: { id: string }) => {
          const t = await ipc.getMeetingTags(m.id);
          map[m.id] = t.map((x: { name: string }) => x.name);
        })
      );
      return map;
    },
    enabled: meetings.length > 0,
  });

  const searchResultMap = useMemo(() => {
    const map: Record<string, SearchResult> = {};
    if (searchResults) {
      for (const r of searchResults) {
        if (!map[r.meeting_id]) {
          map[r.meeting_id] = r;
        }
      }
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
      const matchedIds = new Set(searchResults.map((r: SearchResult) => r.meeting_id));
      list = list.filter((m: { id: string }) => matchedIds.has(m.id));
    } else if (search) {
      list = list.filter((m: { title: string }) =>
        m.title.toLowerCase().includes(search.toLowerCase())
      );
    }

    if (selectedFolder && folderMeetingIds) {
      list = list.filter((m: { id: string }) => folderMeetingIds.includes(m.id));
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
  }, [meetings, search, debouncedSearch, searchResults, selectedFolder, folderMeetingIds, sortBy]);

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

  const notePreviewQueries = useQueries({
    queries: filtered.map((m) => ({
      queryKey: ["note", m.id],
      queryFn: () => ipc.getNoteByMeeting(m.id),
      staleTime: 5 * 60_000,
    })),
  });

  const meetingNotePreviewMap = useMemo(() => {
    const map: Record<string, string> = {};
    filtered.forEach((m, i) => {
      const raw = notePreviewQueries[i]?.data?.raw_content;
      if (raw) {
        const text = extractPlainText(raw, 140);
        if (text) map[m.id] = text;
      }
    });
    return map;
  }, [filtered, notePreviewQueries]);

  const isSearchActive = debouncedSearch.length >= 2;

  function getDuration(m: Meeting): string {
    if (m.actual_start && m.actual_end) {
      const mins = Math.round((new Date(m.actual_end).getTime() - new Date(m.actual_start).getTime()) / 60000);
      if (mins <= 0) return "—";
      if (mins < 60) return `${mins}m`;
      return `${Math.floor(mins / 60)}h ${mins % 60 > 0 ? `${mins % 60}m` : ""}`.trim();
    }
    if (m.scheduled_start && m.scheduled_end) {
      const mins = Math.round((new Date(m.scheduled_end).getTime() - new Date(m.scheduled_start).getTime()) / 60000);
      if (mins < 60) return `${mins}m`;
      return `${Math.floor(mins / 60)}h ${mins % 60 > 0 ? `${mins % 60}m` : ""}`.trim();
    }
    return "—";
  }

  function getAttendeeList(m: Meeting): string {
    try {
      const arr = JSON.parse(m.attendees || "[]");
      if (!Array.isArray(arr) || arr.length === 0) return "—";
      return arr.slice(0, 3).map((a: { name?: string; email?: string }) => a.name || a.email || "").filter(Boolean).join(", ") + (arr.length > 3 ? ` +${arr.length - 3}` : "");
    } catch { return "—"; }
  }

  function getColumnValue(m: Meeting, col: ColumnId, folderMap: Record<string, Folder>): string {
    const dateStr = m.scheduled_start || m.actual_start || m.created_at;
    const d = dateStr ? new Date(dateStr) : null;
    switch (col) {
      case "date": return d ? format(d, "MMM d, yyyy") : "—";
      case "time": return d ? format(d, "h:mm a") : "—";
      case "duration": return getDuration(m);
      case "attendees": return getAttendeeList(m);
      case "location": return m.location || "—";
      case "folder": return folderMap[m.id]?.name || "—";
      case "platform": return m.platform || "—";
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
                <div className="menu-dropdown absolute right-0 top-full mt-1 w-36 border rounded-lg shadow-xl z-50 py-1" style={{ background: "var(--popup-bg)", borderColor: "var(--popup-border)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
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
        {isSearchActive && searchResults && (
          <p className="text-[11px] text-text-muted mt-2">
            {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {/* Content area — flex-1 so it fills remaining height */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {meetingsLoading ? (
          <div className="overflow-y-auto flex-1 px-4 pt-2 pb-6 space-y-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <MeetingCardSkeleton key={i} />
            ))}
          </div>
        ) : filtered.length === 0 && upcomingMeetings.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
            <div className="empty-state-icon">
              {search ? <SearchIcon size={18} /> : <CalendarX size={18} />}
            </div>
            <p className="text-sm font-medium text-text-secondary">
              {search ? "No matching meetings" : "No meetings yet"}
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              {search
                ? "Try a different search term"
                : "Press \u2318N to start your first meeting"}
            </p>
            {!search && (
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
            {!isSearchActive && upcomingMeetings.length > 0 && viewMode === "cards" && (
              <div className="shrink-0 px-4 pt-2 pb-3 border-b border-border/50">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider pb-1.5">
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
                          <p className="text-[13px] font-medium text-text-primary truncate">{m.title}</p>
                          <p className="text-[11px] text-text-muted mt-0.5">
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
                  {filtered.map(m => (
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
                    <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider px-4 py-1.5">
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
