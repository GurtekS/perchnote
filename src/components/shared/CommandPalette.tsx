import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate, useMatchRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Plus,
  Settings,
  Mic,
  MicOff,
  Sparkles,
  Calendar,
  FileText,
  AudioLines,
  BookOpen,
  LayoutList,
} from "lucide-react";
import { ipc, type SearchResult } from "../../lib/ipc";
import { createQuickVoiceNote } from "../../lib/quickNote";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { useRecordingStore } from "../../stores/recordingStore";
import { useUIStore } from "../../stores/uiStore";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { formatMatchTimestamp, groupSearchResults } from "../../lib/searchGrouping";
import { extractFilterChips, FILTER_HINT } from "../../lib/searchFilterHints";
import { FilterChips } from "./FilterChips";

interface PaletteRow {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  action: () => void | Promise<void>;
}

interface CommandItem extends PaletteRow {
  category: "Actions" | "Meetings";
}

interface PaletteSection {
  key: string;
  heading: string;
  rows: PaletteRow[];
}

/** Minimum query length before we fan out to full search (title FTS
 *  covers short prefixes poorly and 1-char LIKE scans everything). */
const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 30;

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Last completed full-search response (plan v8 A3). null = no completed
  // search for the current session (short query, still debouncing/loading,
  // or backend error) — the instant client-side title filter covers those.
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const queryClient = useQueryClient();
  const isRecording = useRecordingStore((s) => s.isRecording);
  const setPendingAutoStart = useUIStore((s) => s.setPendingAutoStart);

  // Detect if the user is currently on a meeting page (URL like /meeting/abc).
  // Used to gate items that only make sense in that context (Enhance Notes).
  const onMeetingPage = !!matchRoute({ to: "/meeting/$id", fuzzy: true });

  const { data: meetings = [] } = useQuery({
    queryKey: ["meetings"],
    queryFn: ipc.listMeetings,
    enabled: open,
  });

  // Gates the Recipes row — same posture as the MeetingHeader button:
  // without an AI provider the affordance shouldn't exist at all.
  const { data: aiConfigured = false } = useQuery({
    queryKey: ["aiConfigured"],
    queryFn: () => ipc.checkAiConfigured(),
    enabled: open && onMeetingPage,
    staleTime: 60_000,
  });

  // Debounced full search across titles, transcripts and notes. Failures
  // fall back to the client-side title filter silently — a toast per
  // keystroke would be worse than degraded search.
  const trimmedQuery = query.trim();
  const searchActive = open && trimmedQuery.length >= SEARCH_MIN_CHARS;
  const filterChips = useMemo(
    () => (searchActive ? extractFilterChips(trimmedQuery) : []),
    [searchActive, trimmedQuery],
  );
  useEffect(() => {
    if (!searchActive) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      ipc.searchAll(trimmedQuery, SEARCH_LIMIT).then(
        (results) => {
          if (!cancelled) setSearchResults(results);
        },
        () => {
          if (!cancelled) setSearchResults(null);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchActive, trimmedQuery]);

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  useFocusTrap(open, dialogRef, closePalette);

  // Open/close with Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (open) closePalette();
        else openPalette();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closePalette, open, openPalette]);

  // Also open via a DOM event so non-keyboard entry points (sidebar search
  // button, etc.) can summon the palette without each one having to know
  // about the open state.
  useEffect(() => {
    const handler = () => {
      openPalette();
    };
    document.addEventListener("open-command-palette", handler);
    return () => document.removeEventListener("open-command-palette", handler);
  }, [openPalette]);

  // Deep-link search (perchnote://search?q=…): a query parked in uiStore
  // summons the palette pre-filled, exactly as if the user typed it.
  const pendingPaletteQuery = useUIStore((s) => s.pendingPaletteQuery);
  useEffect(() => {
    if (pendingPaletteQuery == null) return;
    useUIStore.getState().setPendingPaletteQuery(null);
    openPalette();
    setQuery(pendingPaletteQuery);
  }, [pendingPaletteQuery, openPalette]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const handleAction = useCallback(
    (action: () => void | Promise<void>) => {
      // Actions fire IPC under the hood; a silent failure here looks like the
      // palette "did nothing". Surface sync throws and async rejections.
      try {
        const result = action() as unknown;
        if (result instanceof Promise) {
          result.catch((e) => toast.error(toUserMessage(e, "Action failed")));
        }
      } catch (e) {
        toast.error(toUserMessage(e, "Action failed"));
      }
      closePalette();
    },
    [closePalette]
  );

  const commands: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [
      {
        id: "new-meeting",
        label: "New Meeting",
        // ⌘N is deliberately NOT advertised here: the global shortcut also
        // starts recording, while this palette row creates a quiet draft
        // (the "Start Recording" row below covers the recording intent).
        description: "Without recording",
        icon: <Plus size={16} />,
        category: "Actions",
        action: async () => {
          const m = await ipc.createMeeting("Untitled Meeting");
          queryClient.invalidateQueries({ queryKey: ["meetings"] });
          navigate({ to: "/meeting/$id", params: { id: m.id } });
        },
      },
      {
        id: "toggle-recording",
        label: isRecording ? "Stop Recording" : "Start Recording",
        // Mirrors ⌘N so the sidebar '+' (new WITHOUT recording) and this
        // row stop reading as the same action (deep review: opposite
        // semantics for the same verb across input methods).
        description: isRecording ? undefined : "New meeting + record (⌘N)",
        icon: isRecording ? <MicOff size={16} /> : <Mic size={16} />,
        category: "Actions",
        action: async () => {
          const store = useRecordingStore.getState();
          if (store.isRecording) {
            store.stopRecording();
            return;
          }
          // Starting needs a meeting to record into. Create one and arm the
          // route so MeetingView auto-starts the recording on mount —
          // matches the "New Meeting + record" flow from TodayView.
          const m = await ipc.createMeeting("Untitled Meeting");
          queryClient.invalidateQueries({ queryKey: ["meetings"] });
          setPendingAutoStart(m.id);
          navigate({ to: "/meeting/$id", params: { id: m.id } });
        },
      },
      // Quick Voice Note (discoverability batch): the purpose-built capture
      // flow used to exist only in the menu-bar tray. Same lib flow as the
      // tray listener and ⌘⇧N.
      {
        id: "quick-voice-note",
        label: "Quick Voice Note",
        description: "Records instantly (⌘⇧N)",
        icon: <AudioLines size={16} />,
        category: "Actions",
        action: () =>
          createQuickVoiceNote(queryClient, (id) =>
            navigate({ to: "/meeting/$id", params: { id } }),
          ),
      },
      // The /meetings browser (table view, columns, semantic search) was a
      // half-orphaned route — one conditional button on Home was the only
      // way in (deep review).
      {
        id: "all-meetings",
        label: "All meetings",
        description: "Browse every meeting",
        icon: <LayoutList size={16} />,
        category: "Actions",
        action: () => navigate({ to: "/meetings" }),
      },
    ];

    // Recipes (discoverability batch): the panel lives in MeetingHeader and
    // only renders on a non-recording meeting page — gate the row the same
    // way so it can never fire into the void.
    if (onMeetingPage && !isRecording && aiConfigured) {
      items.push({
        id: "recipes",
        label: "Recipes…",
        description: "Run a saved prompt",
        icon: <BookOpen size={16} />,
        category: "Actions",
        action: () => {
          document.dispatchEvent(new CustomEvent("open-recipes"));
        },
      });
    }

    // Only offer Enhance Notes when there's a meeting on screen to enhance.
    // MeetingView listens for `palette-enhance-notes` and triggers its
    // existing enhance flow.
    if (onMeetingPage) {
      items.push({
        id: "enhance-notes",
        label: "Enhance notes",
        description: "Cmd+E",
        icon: <Sparkles size={16} />,
        category: "Actions",
        action: () => {
          document.dispatchEvent(new CustomEvent("palette-enhance-notes"));
        },
      });
    }

    items.push({
      id: "settings",
      label: "Open Settings",
      description: "Cmd+,",
      icon: <Settings size={16} />,
      category: "Actions",
      action: () => navigate({ to: "/settings" }),
    });

    // Add meetings as searchable items (fuzzy match by title)
    meetings.forEach((m) => {
      items.push({
        id: `meeting-${m.id}`,
        label: m.title,
        description: m.status === "recording" ? "Recording" : undefined,
        icon:
          m.status === "recording" ? (
            <Mic size={16} className="text-recording" />
          ) : (
            <Calendar size={16} />
          ),
        category: "Meetings",
        action: () => navigate({ to: "/meeting/$id", params: { id: m.id } }),
      });
    });

    return items;
  }, [meetings, isRecording, navigate, queryClient, onMeetingPage, aiConfigured, setPendingAutoStart]);

  const filtered = useMemo(() => {
    if (!query) return commands;
    const lower = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(lower) ||
        c.description?.toLowerCase().includes(lower)
    );
  }, [commands, query]);

  // Jump-to-moment for transcript hits. Sequencing matters because the
  // target MeetingView may not be mounted yet:
  // 1. Park the seek in uiStore BEFORE navigating — MeetingView consumes
  //    pendingSeek entries keyed to its meeting, opens the transcript
  //    drawer, and re-dispatches seek-audio once the drawer can hear it
  //    (same handoff NoteCard search hits use).
  // 2. After navigation commits (or immediately when we're already on that
  //    meeting — the keyed consumer never re-runs there), dispatch the
  //    seek-audio event directly, same shape as timestampChip.
  const openMeetingAtMoment = useCallback(
    async (meetingId: string, ms: number) => {
      const current = matchRoute({ to: "/meeting/$id", fuzzy: true }) as
        | { id?: string }
        | false;
      const alreadyThere = !!current && current.id === meetingId;
      if (!alreadyThere) {
        useUIStore.getState().setPendingSeek(meetingId, ms);
        await navigate({ to: "/meeting/$id", params: { id: meetingId } });
      }
      window.dispatchEvent(new CustomEvent("seek-audio", { detail: { ms } }));
    },
    [matchRoute, navigate]
  );

  const searchResultToRow = useCallback(
    (result: SearchResult): PaletteRow => {
      const id = `search-${result.meeting_id}-${result.match_source}`;
      const openMeeting = () =>
        navigate({ to: "/meeting/$id", params: { id: result.meeting_id } });
      if (result.match_source === "transcript" && result.match_start_ms != null) {
        const ms = result.match_start_ms;
        return {
          id,
          label: `[${formatMatchTimestamp(ms)}] ${result.snippet}`,
          icon: <AudioLines size={16} />,
          action: () => openMeetingAtMoment(result.meeting_id, ms),
        };
      }
      if (result.match_source === "transcript") {
        return { id, label: result.snippet, icon: <AudioLines size={16} />, action: openMeeting };
      }
      if (result.match_source === "notes" || result.match_source === "note") {
        return {
          id,
          label: result.snippet,
          description: "note",
          icon: <FileText size={16} />,
          action: openMeeting,
        };
      }
      // Title hit — the snippet IS the title; selecting just opens the meeting.
      return { id, label: result.snippet, icon: <Calendar size={16} />, action: openMeeting };
    },
    [navigate, openMeetingAtMoment]
  );

  // Sections drive both rendering and keyboard order. Actions stay
  // client-filtered (instant). The meetings area shows grouped full-search
  // results once they exist for this session; until then (debouncing,
  // in-flight, error, short query) it falls back to the instant title
  // filter so the palette never feels laggy.
  const showGroupedSearch = searchActive && searchResults !== null;
  const sections = useMemo<PaletteSection[]>(() => {
    const out: PaletteSection[] = [];
    const actionRows = filtered.filter((c) => c.category === "Actions");
    if (actionRows.length > 0) {
      out.push({ key: "actions", heading: "Actions", rows: actionRows });
    }
    if (showGroupedSearch) {
      for (const group of groupSearchResults(searchResults, meetings)) {
        out.push({
          key: `search-${group.meetingId}`,
          heading: group.dateLabel ? `${group.title} · ${group.dateLabel}` : group.title,
          rows: group.rows.map(searchResultToRow),
        });
      }
    } else {
      const meetingRows = filtered.filter((c) => c.category === "Meetings");
      if (meetingRows.length > 0) {
        out.push({ key: "meetings", heading: "Meetings", rows: meetingRows });
      }
    }
    return out;
  }, [filtered, showGroupedSearch, searchResults, meetings, searchResultToRow]);

  // Flattened rows in visual order — the roving selection traverses this.
  const flatRows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(flatRows.length - 1, 0)));
  }, [flatRows.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, flatRows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && flatRows[selectedIndex]) {
      e.preventDefault();
      handleAction(flatRows[selectedIndex].action);
    }
  };

  if (!open) return null;

  let globalIndex = 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={closePalette}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass-float relative w-full max-w-lg rounded-xl overflow-hidden"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={16} className="text-text-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search commands and meetings"
            aria-controls="command-palette-results"
            aria-activedescendant={flatRows[selectedIndex] ? `command-palette-${flatRows[selectedIndex].id}` : undefined}
            placeholder="Search meetings, actions…"
            className="flex-1 bg-transparent text-text-primary text-sm focus:outline-none placeholder:text-text-muted"
          />
          <kbd className="text-footnote text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded border border-border font-mono">
            ESC
          </kbd>
        </div>

        {/* Active filter chips (plan v8 A3): reflect which grammar filters
            the backend will apply; a malformed date is shown as ignored
            instead of silently doing nothing. */}
        <FilterChips chips={filterChips} className="px-4 py-2 border-b border-border" />

        {/* Results */}
        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Command results"
          className="max-h-80 overflow-y-auto py-2"
        >
          {flatRows.length === 0 && (
            <p className="px-4 py-6 text-sm text-text-muted text-center" role="status">
              {searchActive && searchResults === null ? "Searching…" : "No results found"}
            </p>
          )}
          {sections.map((section) => (
            <div key={section.key} role="group" aria-label={section.heading}>
              <div className="px-4 py-1">
                <span className="text-footnote font-semibold text-text-muted uppercase tracking-wider">
                  {section.heading}
                </span>
              </div>
              {section.rows.map((item) => {
                const idx = globalIndex++;
                return (
                  <button
                    type="button"
                    id={`command-palette-${item.id}`}
                    role="option"
                    aria-selected={selectedIndex === idx}
                    key={item.id}
                    onClick={() => handleAction(item.action)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                      selectedIndex === idx
                        ? "bg-accent/10 text-accent"
                        : "text-text-secondary hover:bg-bg-hover"
                    }`}
                  >
                    <span className="shrink-0 opacity-70">{item.icon}</span>
                    <span className="flex-1 text-sm truncate">{item.label}</span>
                    {item.description && (
                      <span className="text-xs text-text-muted shrink-0">
                        {item.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer: nav hints at rest; filter-grammar hint while typing a
            search (that's the moment the syntax is discoverable). */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-footnote text-text-muted">
          {searchActive ? (
            <span className="truncate font-mono" title={FILTER_HINT}>
              {FILTER_HINT}
            </span>
          ) : (
            <>
              <span>
                <kbd className="font-mono">up/down</kbd> Navigate
              </span>
              <span>
                <kbd className="font-mono">enter</kbd> Select
              </span>
              <span>
                <kbd className="font-mono">esc</kbd> Close
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
