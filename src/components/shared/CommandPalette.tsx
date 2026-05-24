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
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useRecordingStore } from "../../stores/recordingStore";
import { useUIStore } from "../../stores/uiStore";

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  action: () => void;
  category: "Actions" | "Meetings";
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
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

  const openPalette = useCallback(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => previousFocusRef.current?.focus(), 0);
  }, []);

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

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closePalette();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closePalette, open]);

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

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const handleAction = useCallback(
    (action: () => void) => {
      action();
      closePalette();
    },
    [closePalette]
  );

  const commands: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [
      {
        id: "new-meeting",
        label: "New Meeting",
        description: "Cmd+N",
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
          setPendingAutoStart(true);
          navigate({ to: "/meeting/$id", params: { id: m.id } });
        },
      },
    ];

    // Only offer Enhance Notes when there's a meeting on screen to enhance.
    // MeetingView listens for `palette-enhance-notes` and triggers its
    // existing enhance flow.
    if (onMeetingPage) {
      items.push({
        id: "enhance-notes",
        label: "Enhance Notes",
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
  }, [meetings, isRecording, navigate, queryClient, onMeetingPage, setPendingAutoStart]);

  const filtered = useMemo(() => {
    if (!query) return commands;
    const lower = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(lower) ||
        c.description?.toLowerCase().includes(lower)
    );
  }, [commands, query]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      handleAction(filtered[selectedIndex].action);
    }
  };

  if (!open) return null;

  // Group filtered results by category
  const grouped = filtered.reduce<Record<string, CommandItem[]>>((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});

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
        className="relative w-full max-w-lg bg-bg-secondary border border-border rounded-xl shadow-2xl overflow-hidden"
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
            aria-activedescendant={filtered[selectedIndex] ? `command-palette-${filtered[selectedIndex].id}` : undefined}
            placeholder="Search meetings, actions..."
            className="flex-1 bg-transparent text-text-primary text-sm focus:outline-none placeholder:text-text-muted"
          />
          <kbd className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded border border-border font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Command results"
          className="max-h-80 overflow-y-auto py-2"
        >
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-sm text-text-muted text-center" role="status">
              No results found
            </p>
          )}
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category}>
              <div className="px-4 py-1">
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                  {category}
                </span>
              </div>
              {items.map((item) => {
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

        {/* Footer */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-[10px] text-text-muted">
          <span>
            <kbd className="font-mono">up/down</kbd> Navigate
          </span>
          <span>
            <kbd className="font-mono">enter</kbd> Select
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}
