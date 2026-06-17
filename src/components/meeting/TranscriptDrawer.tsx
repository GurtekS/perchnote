import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  X,
  Search,
  Copy,
  Check,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Users,
  Pencil,
  Mic,
  Star,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ipc, Transcript } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { IdentifySpeakersPanel } from "./IdentifySpeakersPanel";

interface TranscriptSegment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  speaker_confidence?: number;
  /** ⌘D while recording, or the star toggle here. */
  highlighted?: boolean;
}

interface TranscriptDrawerProps {
  meetingId: string;
  isOpen: boolean;
  onClose: () => void;
  liveSegments?: TranscriptSegment[];
  isRecording?: boolean;
  meetingStatus?: string;
}

type DrawerTab = "transcript" | "speakers";

const SPEAKER_COLORS = [
  "bg-blue-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-purple-400",
  "bg-pink-400",
  "bg-cyan-400",
];

function getSpeakerBgColor(speaker: string): string {
  const num = parseInt(speaker.replace(/\D/g, ""), 10) || 0;
  return SPEAKER_COLORS[(num - 1) % SPEAKER_COLORS.length];
}

export function TranscriptDrawer({
  meetingId,
  isOpen,
  onClose,
  liveSegments = [],
  isRecording = false,
  meetingStatus,
}: TranscriptDrawerProps) {
  const queryClient = useQueryClient();
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("transcript");
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);

  // Speaker the Speakers tab should focus on open — set by the inline
  // speaker pills, which route renames to the tab's identify panel instead
  // of a separate bespoke editor (UX audit: three rename surfaces → one).
  const [speakerFocus, setSpeakerFocus] = useState<string | null>(null);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [audioError, setAudioError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // Active segment ref for auto-scroll
  // Live transcript bottom ref
  const liveBottomRef = useRef<HTMLDivElement>(null);

  const { data: transcript } = useQuery({
    queryKey: ["transcript", meetingId],
    queryFn: () => ipc.getTranscriptByMeeting(meetingId),
  });

  const { data: speakerLabels = [] } = useQuery({
    queryKey: ["speakerLabels", meetingId],
    queryFn: () => ipc.listSpeakerLabelsForMeeting(meetingId),
  });

  const speakerLabelMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const sl of speakerLabels) {
      map[sl.speaker_key] = sl.display_name;
    }
    return map;
  }, [speakerLabels]);

  const getDisplayName = useCallback(
    (speaker: string | null) => {
      if (!speaker) return "Unknown";
      return speakerLabelMap[speaker] || speaker;
    },
    [speakerLabelMap]
  );

  // Seek requests from note source chips (plan rank 2). Buffered so a chip
  // click that opens the drawer still seeks once the audio element exists.
  const pendingSeekRef = useRef<number | null>(null);
  const applyPendingSeek = useCallback(() => {
    const ms = pendingSeekRef.current;
    const a = audioRef.current;
    if (ms == null || !a) return;
    pendingSeekRef.current = null;
    a.currentTime = ms / 1000;
    a.play().catch(() => {});
  }, []);
  useEffect(() => {
    const onSeek = (e: Event) => {
      const ms = (e as CustomEvent<{ ms: number }>).detail?.ms;
      if (typeof ms !== "number") return;
      pendingSeekRef.current = ms;
      applyPendingSeek();
    };
    window.addEventListener("seek-audio", onSeek);
    return () => window.removeEventListener("seek-audio", onSeek);
  }, [applyPendingSeek]);
  useEffect(() => {
    if (isOpen && audioSrc) {
      const t = setTimeout(applyPendingSeek, 350);
      return () => clearTimeout(t);
    }
  }, [isOpen, audioSrc, applyPendingSeek]);

  // Reset filters when switching meetings
  useEffect(() => {
    setSearchQuery("");
    setShowOnlyHighlights(false);
  }, [meetingId]);

  // Load audio
  useEffect(() => {
    if (!isOpen) return;
    setAudioError(false);
    let cancelled = false;
    invoke<string | null>("get_recording_path", { meetingId }).then((path) => {
      if (cancelled) return;
      if (path) {
        setAudioSrc(convertFileSrc(path));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [meetingId, isOpen]);

  // Auto-scroll live segments
  useEffect(() => {
    if (isRecording && liveSegments.length > 0 && liveBottomRef.current) {
      liveBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [isRecording, liveSegments.length]);

  const storedSegments = useMemo(() => parseSegments(transcript), [transcript]);

  // When recording, use live segments; otherwise use stored
  const segments = isRecording && liveSegments.length > 0 ? liveSegments : storedSegments;

  // Determine if meeting is under 1 hour
  const isUnderOneHour = useMemo(() => {
    if (segments.length === 0) return true;
    const lastEnd = segments[segments.length - 1]?.end_ms || 0;
    return lastEnd < 3600000;
  }, [segments]);

  // Topic trackers (ported from the orphaned TranscriptView — plan v7 #23):
  // user-defined terms counted across the transcript; a chip click reuses
  // the search filter. Pure local string matching.
  const { data: trackerTermsRaw = "" } = useQuery({
    queryKey: ["setting", "topic_trackers"],
    queryFn: () => ipc.getSetting("topic_trackers").then((v) => v ?? ""),
    staleTime: 60_000,
  });
  const trackerHits = useMemo(() => {
    const terms = trackerTermsRaw
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    if (terms.length === 0 || segments.length === 0) return [];
    return terms
      .map((term) => {
        const q = term.toLowerCase();
        const count = segments.reduce(
          (acc, seg) => acc + (seg.text.toLowerCase().includes(q) ? 1 : 0),
          0,
        );
        return { term, count };
      })
      .filter((t) => t.count > 0);
  }, [trackerTermsRaw, segments]);

  // ⌘D flagged moments (also ported): filter to them, toggle per segment.
  const [showOnlyHighlights, setShowOnlyHighlights] = useState(false);
  const highlightCount = useMemo(
    () => segments.filter((s) => s.highlighted).length,
    [segments],
  );
  // Un-starring the last flag while the lens is on stranded a blank
  // transcript with the toggle gone (QA audit finding 3) — force it off.
  useEffect(() => {
    if (showOnlyHighlights && highlightCount === 0) setShowOnlyHighlights(false);
  }, [showOnlyHighlights, highlightCount]);
  const toggleHighlight = useCallback(
    async (index: number) => {
      try {
        await ipc.toggleSegmentHighlight(meetingId, index);
        queryClient.invalidateQueries({ queryKey: ["transcript", meetingId] });
      } catch (e) {
        toast.error(toUserMessage(e));
      }
    },
    [meetingId, queryClient],
  );

  // Transcript correction (plan v9 #8): inline segment edit + replace-all.
  // One misheard name poisons search, embeddings, and every AI pass — this
  // is where it gets fixed.
  const [editing, setEditing] = useState<{ idx: number; draft: string } | null>(null);
  const [replaceDraft, setReplaceDraft] = useState("");
  // Durable affordance for sticky fixes (deep review P2: the only way to
  // make a correction permanent was an 8-second toast).
  const [alwaysFix, setAlwaysFix] = useState(false);
  useEffect(() => {
    setEditing(null);
    setReplaceDraft("");
  }, [meetingId]);
  // Edits are addressed by segment index, and the accuracy pass swaps the
  // whole segment list in the background minutes after stop — the index
  // under an open editor then names a different utterance. Abort the
  // in-flight edit rather than save onto the wrong segment.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ meeting_id: string }>("transcript-upgraded", (event) => {
      if (event.payload.meeting_id !== meetingId) return;
      setEditing((cur) => {
        if (cur) {
          toast.info(
            "The transcript was upgraded by the accuracy pass — please redo that edit",
            "Edit not saved",
          );
        }
        return null;
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [meetingId]);
  const saveEdit = useCallback(async () => {
    if (!editing || !editing.draft.trim()) return;
    try {
      await ipc.updateSegmentText(meetingId, editing.idx, editing.draft.trim());
      queryClient.invalidateQueries({ queryKey: ["transcript", meetingId] });
      setEditing(null);
    } catch (e) {
      toast.error(toUserMessage(e), "Couldn't save the edit");
    }
  }, [editing, meetingId, queryClient]);
  const replaceAll = useCallback(async () => {
    const find = searchQuery.trim();
    const replace = replaceDraft.trim();
    if (!find || !replace) return;
    try {
      const n = await ipc.replaceInTranscript(meetingId, find, replace);
      queryClient.invalidateQueries({ queryKey: ["transcript", meetingId] });
      if (n > 0 && alwaysFix) {
        try {
          const { addCorrectionRule } = await import("../../lib/correctionRules");
          await addCorrectionRule(find, replace);
          queryClient.invalidateQueries({ queryKey: ["correction-rules"] });
          toast.success(`Replaced in ${n} segment${n === 1 ? "" : "s"} — “${find}” → “${replace}” will be fixed in every future transcript`);
          setReplaceDraft("");
          setAlwaysFix(false);
          return;
        } catch (e) {
          toast.error(toUserMessage(e), "Replaced, but the rule couldn't be saved");
          return;
        }
      }
      if (n > 0) {
        // Sticky rules (plan v10 #5): the same misheard name returns every
        // meeting — one click makes this fix permanent for future ASR.
        toast.action(
          `Replaced in ${n} segment${n === 1 ? "" : "s"}`,
          "Always make this fix",
          async () => {
            try {
              const { addCorrectionRule } = await import("../../lib/correctionRules");
              await addCorrectionRule(find, replace);
              // An open Audio Settings panel shows the rule list live.
              queryClient.invalidateQueries({ queryKey: ["correction-rules"] });
              toast.success(
                `"${find}" → "${replace}" will be fixed in every future transcript (manage in Audio settings)`,
              );
            } catch (e) {
              toast.error(toUserMessage(e), "Couldn't save the rule");
            }
          },
          "Replaced",
        );
        setReplaceDraft("");
      } else {
        toast.info(
          `No matches for “${find}” — check spelling and punctuation; matching ignores letter case.`,
        );
      }
    } catch (e) {
      toast.error(toUserMessage(e), "Replace failed");
    }
  }, [searchQuery, replaceDraft, meetingId, queryClient]);

  // Search has two modes (plan v9 #11): find-in-context (default — every
  // segment stays visible, matches highlighted, n/N stepping) and the old
  // filter mode (hide non-matching). Filtering loses the conversation
  // around a hit; finding keeps it.
  const [filterMode, setFilterMode] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);

  // Filter by flagged-only and (in filter mode) search. Items carry their
  // index in the FULL segment array — the highlight toggle is keyed on it.
  const filteredSegments = useMemo(() => {
    let list = segments.map((seg, idx) => ({ seg, idx }));
    if (showOnlyHighlights) list = list.filter(({ seg }) => seg.highlighted);
    if (searchQuery.trim() && filterMode) {
      const q = searchQuery.toLowerCase();
      list = list.filter(({ seg }) => seg.text.toLowerCase().includes(q));
    }
    return list;
  }, [segments, searchQuery, showOnlyHighlights, filterMode]);

  // Display-list indexes of matching rows — the find-mode step targets.
  const matchIndexes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    filteredSegments.forEach(({ seg }, i) => {
      if (seg.text.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [filteredSegments, searchQuery]);

  useEffect(() => {
    setActiveMatch(0);
  }, [searchQuery, filterMode, meetingId]);

  // Active segment tracking (for playback highlight)
  const activeSegmentStart = useMemo(() => {
    if (!isPlaying) return -1;
    const ms = currentTime * 1000;
    let last = -1;
    for (const seg of segments) {
      if (seg.start_ms <= ms) last = seg.start_ms;
      else break;
    }
    return last;
  }, [currentTime, segments, isPlaying]);

  // Virtualized rows (plan v7 lifetime 17): a 2h meeting is 1000-2500
  // segments × ~10 DOM nodes each; rendering them all made every playback
  // tick and search keystroke re-render 15-25k nodes. Only ~20 visible
  // rows exist at a time now.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredSegments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  // Auto-scroll playback to the active segment — the row may not be
  // mounted, so this goes through the virtualizer, not a DOM ref.
  useEffect(() => {
    if (!isPlaying || activeSegmentStart < 0) return;
    const idx = filteredSegments.findIndex(({ seg }) => seg.start_ms === activeSegmentStart);
    if (idx >= 0) rowVirtualizer.scrollToIndex(idx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSegmentStart, isPlaying]);

  // Find-mode stepping: Enter/▼ next, Shift+Enter/▲ previous, wrapping.
  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (matchIndexes.length === 0) return;
      setActiveMatch((m) => {
        const next = (m + dir + matchIndexes.length) % matchIndexes.length;
        rowVirtualizer.scrollToIndex(matchIndexes[next], { align: "center" });
        return next;
      });
    },
    [matchIndexes, rowVirtualizer],
  );

  // Bring the current match into view when a find begins or matches move
  // (typing narrows the set). Playback auto-scroll wins while playing.
  useEffect(() => {
    if (filterMode || isPlaying || matchIndexes.length === 0) return;
    const idx = matchIndexes[Math.min(activeMatch, matchIndexes.length - 1)];
    rowVirtualizer.scrollToIndex(idx, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIndexes, activeMatch, filterMode]);

  const handleCopy = async () => {
    const text = segments
      .map((s) => {
        const name = getDisplayName(s.speaker);
        const time = formatMs(s.start_ms, isUnderOneHour);
        return `[${time}] ${name}: ${s.text}`;
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Transcript copied");
    setTimeout(() => setCopied(false), 2000);
  };

  // Audio controls
  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      if (isPlaying) {
        audio.pause();
      } else {
        await audio.play();
      }
    } catch (e) {
      toast.error(toUserMessage(e), "Playback failed");
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = parseFloat(e.target.value);
    setCurrentTime(audio.currentTime);
  };

  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  };

  const cycleSpeed = () => {
    const speeds = [1, 1.5, 2];
    const idx = speeds.indexOf(playbackSpeed);
    const next = speeds[(idx + 1) % speeds.length];
    setPlaybackSpeed(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
    }
  };

  const seekToTimestamp = async (ms: number) => {
    const audio = audioRef.current;
    if (!audio || !audioSrc) return;
    audio.currentTime = ms / 1000;
    if (!isPlaying) {
      try {
        await audio.play();
      } catch (e) {
        toast.error(toUserMessage(e), "Playback failed");
      }
    }
  };

  // Open the Speakers tab landed on one speaker's rename field — the
  // single identification/rename surface (re-detect lives there too).
  const openSpeakersTab = (speaker: string | null) => {
    setSpeakerFocus(speaker);
    setDrawerTab("speakers");
  };

  if (!isOpen) return null;

  const isLive = isRecording && liveSegments.length > 0;

  return (
    <aside data-pane="drawer" className="drawer-enter flex h-full w-[min(400px,100%)] min-w-[320px] shrink-0 flex-col border-l border-border bg-bg-primary" aria-label="Transcript drawer">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5 sm:px-4">
        {/* Tabs */}
        <div className="view-toggle-pill" role="group" aria-label="Transcript drawer view">
          <button
            type="button"
            onClick={() => setDrawerTab("transcript")}
            className={drawerTab === "transcript" ? "active" : ""}
            aria-pressed={drawerTab === "transcript"}
          >
            {isLive && (
              <span className="flex h-1.5 w-1.5 rounded-full bg-recording animate-pulse" />
            )}
            Transcript
          </button>
          <button
            type="button"
            onClick={() => openSpeakersTab(null)}
            className={drawerTab === "speakers" ? "active" : ""}
            aria-pressed={drawerTab === "speakers"}
          >
            <Users size={11} />
            Speakers
          </button>
        </div>
        {/* Actions */}
        <div className="flex items-center gap-1">
          {drawerTab === "transcript" && (
            <button
              type="button"
              onClick={handleCopy}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              aria-label={copied ? "Transcript copied" : "Copy transcript"}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close transcript"
            aria-label="Close transcript"
            className="icon-btn"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* ── Transcript Tab ── */}
      {drawerTab === "transcript" && (
        <>
          {/* Search (only for stored transcript) */}
          {!isLive && (
            <div className="px-4 py-2 border-b border-border shrink-0">
              <div className="flex items-center gap-1.5 bg-bg-tertiary rounded-lg px-2.5 py-1.5">
                <Search size={12} className="text-text-muted shrink-0" />
                <label htmlFor="transcript-search" className="sr-only">Search transcript</label>
                <input
                  id="transcript-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !filterMode) {
                      e.preventDefault();
                      stepMatch(e.shiftKey ? -1 : 1);
                    }
                  }}
                  placeholder="Find in transcript…"
                  className="bg-transparent text-xs text-text-primary focus:outline-none flex-1 placeholder:text-text-muted"
                />
                {searchQuery && !filterMode && (
                  <>
                    <button
                      type="button"
                      onClick={() => stepMatch(-1)}
                      disabled={matchIndexes.length === 0}
                      className="text-text-muted hover:text-text-primary disabled:opacity-40"
                      aria-label="Previous match"
                    >
                      <ChevronUp size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => stepMatch(1)}
                      disabled={matchIndexes.length === 0}
                      className="text-text-muted hover:text-text-primary disabled:opacity-40"
                      aria-label="Next match"
                    >
                      <ChevronDown size={11} />
                    </button>
                  </>
                )}
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="text-text-muted hover:text-text-primary"
                    aria-label="Clear transcript search"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
              {searchQuery && (
                <div className="mt-1 flex items-center gap-2 text-footnote text-text-muted">
                  <span data-testid="match-count">
                    {filterMode
                      ? `${filteredSegments.length} result${filteredSegments.length !== 1 ? "s" : ""}`
                      : matchIndexes.length === 0
                        ? "No matches"
                        : `${Math.min(activeMatch + 1, matchIndexes.length)} of ${matchIndexes.length}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFilterMode((f) => !f)}
                    aria-pressed={filterMode}
                    title={filterMode ? "Show every segment, step between matches" : "Hide segments that don't match"}
                    className={`rounded-full border px-2 py-0.5 transition-colors ${
                      filterMode
                        ? "border-accent/40 bg-accent/10 text-accent"
                        : "border-border text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Filter
                  </button>
                </div>
              )}
              {/* Replace-all rides the find (plan v9 #8): the search query
                  is the find term; one click fixes a misheard name
                  everywhere. */}
              {searchQuery.trim() && matchIndexes.length > 0 && !filterMode && (
                <>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    type="text"
                    value={replaceDraft}
                    onChange={(e) => setReplaceDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && replaceDraft.trim()) {
                        e.preventDefault();
                        replaceAll();
                      }
                    }}
                    placeholder="Replace with…"
                    aria-label="Replacement text"
                    className="flex-1 rounded-lg bg-bg-tertiary px-2.5 py-1 text-xs text-text-primary focus:outline-none placeholder:text-text-muted"
                  />
                  <button
                    type="button"
                    onClick={replaceAll}
                    disabled={!replaceDraft.trim()}
                    className="rounded-lg border border-border px-2 py-1 text-footnote text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40"
                  >
                    Replace all
                  </button>
                </div>
                <label className="mt-1 flex w-fit cursor-pointer items-center gap-1.5 text-footnote text-text-muted">
                  <input
                    type="checkbox"
                    checked={alwaysFix}
                    onChange={(e) => setAlwaysFix(e.target.checked)}
                    className="h-3 w-3 accent-[var(--accent)]"
                  />
                  Always make this fix in future transcripts
                </label>
                </>
              )}
              {/* Topic trackers + flagged-moments lens */}
              {(trackerHits.length > 0 || highlightCount > 0) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {trackerHits.map(({ term, count }) => {
                    const active = searchQuery.toLowerCase() === term.toLowerCase();
                    return (
                      <button
                        key={term}
                        type="button"
                        onClick={() => setSearchQuery(active ? "" : term)}
                        aria-pressed={active}
                        className={`rounded-full border px-2 py-0.5 text-footnote transition-colors ${
                          active
                            ? "border-accent/40 bg-accent/10 text-accent"
                            : "border-border text-text-muted hover:text-text-secondary"
                        }`}
                      >
                        {term} · {count}
                      </button>
                    );
                  })}
                  {highlightCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowOnlyHighlights((v) => !v)}
                      aria-pressed={showOnlyHighlights}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-footnote transition-colors ${
                        showOnlyHighlights
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                          : "border-border text-text-muted hover:text-text-secondary"
                      }`}
                    >
                      <Star size={9} fill={showOnlyHighlights ? "currentColor" : "none"} />
                      Flagged · {highlightCount}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Live indicator banner */}
          {isLive && (
            <div className="px-4 py-1.5 border-b border-border bg-recording/5 shrink-0 flex items-center gap-1.5">
              <span className="flex h-1.5 w-1.5 rounded-full bg-recording animate-pulse" />
              <span className="text-caption font-medium text-recording">Live</span>
              <span className="text-caption text-text-muted ml-1">{liveSegments.length} segment{liveSegments.length !== 1 ? "s" : ""}</span>
            </div>
          )}

          {/* Transcript content — aria-live so screen readers announce new
              segments as they stream in during a recording */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-3"
            aria-live={isLive ? "polite" : "off"}
            aria-atomic="false"
          >
            {segments.length === 0 ? (
              <div className="empty-state h-full px-4 py-12">
                <div className="empty-state-icon">
                  <Mic size={24} />
                </div>
                <p className="text-sm font-medium">
                  {isRecording ? "Listening…" : meetingStatus === "complete" ? "No transcript" : "No transcript yet"}
                </p>
                <p className="text-xs text-center max-w-[200px] leading-relaxed">
                  {isRecording
                    ? "Transcript will appear here as you speak."
                    : meetingStatus === "transcribing"
                    ? "Transcribing… this can take a few minutes for long recordings."
                    : meetingStatus === "complete"
                    ? "No transcript was captured for this meeting."
                    : "Record this meeting to generate a transcript."}
                </p>
              </div>
            ) : (
              <div
                style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
              >
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const { seg, idx } = filteredSegments[vi.index];
                const prevSpeaker = vi.index > 0 ? filteredSegments[vi.index - 1].seg.speaker : null;
                const showSpeaker = seg.speaker !== prevSpeaker;
                const isActive = !isLive && seg.start_ms === activeSegmentStart;
                const isFindTarget =
                  !filterMode &&
                  matchIndexes.length > 0 &&
                  matchIndexes[Math.min(activeMatch, matchIndexes.length - 1)] === vi.index;

                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                    }}
                    className={`${showSpeaker ? "pt-3" : ""} pb-0.5`}
                  >
                    {showSpeaker && seg.speaker && (
                      <div className="flex items-center gap-2 mb-1">
                        {/* Speaker pill — click opens the Speakers tab on
                            this speaker's rename field (one rename surface,
                            not a bespoke inline editor). */}
                        <button
                          type="button"
                          onClick={() => openSpeakersTab(seg.speaker!)}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption font-medium text-white ${getSpeakerBgColor(seg.speaker)} hover:opacity-80 transition-opacity`}
                          title="Rename in the Speakers tab"
                          aria-label={`Rename speaker ${getDisplayName(seg.speaker)}`}
                        >
                          {getDisplayName(seg.speaker)}
                          <Pencil size={8} className="opacity-60" />
                        </button>
                        <button
                          type="button"
                          onClick={() => seekToTimestamp(seg.start_ms)}
                          className="text-footnote text-text-muted hover:text-accent transition-colors cursor-pointer"
                          aria-label={`Play from ${formatMs(seg.start_ms, isUnderOneHour)}`}
                        >
                          {formatMs(seg.start_ms, isUnderOneHour)}
                        </button>
                      </div>
                    )}
                    <div
                      onClick={() => !isLive && seekToTimestamp(seg.start_ms)}
                      className={`group flex items-start gap-2 rounded-lg px-1 py-0.5 transition-colors ${
                        !isLive
                          ? "cursor-pointer hover:bg-bg-hover"
                          : ""
                      } ${isActive ? "bg-accent/8" : ""} ${seg.highlighted ? "bg-amber-500/5" : ""} ${
                        isFindTarget ? "ring-1 ring-accent/40 bg-accent/5" : ""
                      }`}
                      data-find-target={isFindTarget || undefined}
                    >
                      {!isLive && (
                        <Play
                          size={10}
                          className="mt-1 shrink-0 text-accent opacity-0 transition-opacity group-hover:opacity-50 group-focus-within:opacity-50"
                        />
                      )}
                      {editing?.idx === idx ? (
                        <div className="flex-1" onClick={(e) => e.stopPropagation()}>
                          <textarea
                            value={editing.draft}
                            onChange={(e) => setEditing({ idx, draft: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                saveEdit();
                              } else if (e.key === "Escape") {
                                e.stopPropagation();
                                setEditing(null);
                              }
                            }}
                            autoFocus
                            rows={2}
                            aria-label="Edit segment text"
                            className="w-full rounded-lg border border-accent/40 bg-bg-tertiary px-2 py-1 text-body-sm text-text-primary leading-relaxed focus:outline-none"
                          />
                          <div className="mt-0.5 flex gap-2 text-footnote text-text-muted">
                            <button type="button" onClick={saveEdit} className="text-accent hover:underline">
                              Save
                            </button>
                            <button type="button" onClick={() => setEditing(null)} className="hover:text-text-primary">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-body-sm text-text-primary leading-relaxed flex-1">
                          {searchQuery
                            ? highlightSearch(seg.text, searchQuery)
                            : seg.text}
                        </p>
                      )}
                      {!isLive && editing?.idx !== idx && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing({ idx, draft: seg.text });
                          }}
                          aria-label="Edit segment text"
                          title="Fix what was transcribed"
                          className="shrink-0 pt-0.5 text-text-muted opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-60 group-focus-within:opacity-100 hover:!opacity-100 hover:text-text-primary"
                        >
                          <Pencil size={10} />
                        </button>
                      )}
                      {!isLive && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleHighlight(idx); }}
                          aria-label={seg.highlighted ? "Remove flag from this moment" : "Flag this moment"}
                          aria-pressed={!!seg.highlighted}
                          className={`shrink-0 pt-0.5 transition-opacity ${
                            seg.highlighted
                              ? "text-amber-500 opacity-100"
                              : "text-text-muted opacity-0 hover:text-amber-500 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                          }`}
                        >
                          <Star size={10} fill={seg.highlighted ? "currentColor" : "none"} />
                        </button>
                      )}
                      {!showSpeaker && !isLive && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); seekToTimestamp(seg.start_ms); }}
                          className="shrink-0 cursor-pointer pt-0.5 text-footnote text-text-muted opacity-0 transition-opacity hover:text-accent focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                          aria-label={`Play from ${formatMs(seg.start_ms, isUnderOneHour)}`}
                        >
                          {formatMs(seg.start_ms, isUnderOneHour)}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
            )}
            {isLive && <div ref={liveBottomRef} />}
          </div>

          {/* Playback unavailable notice */}
          {audioSrc && audioError && !isLive && (
            <div className="border-t border-border px-4 py-2 shrink-0 text-caption text-text-muted flex items-center gap-2">
              <span>Recording not playable in this format</span>
            </div>
          )}

          {/* Mini audio player (only for stored transcript) */}
          {audioSrc && !audioError && !isLive && (
            <div className="border-t border-border bg-bg-secondary px-4 py-2.5 shrink-0">
              <audio
                ref={audioRef}
                src={audioSrc}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onTimeUpdate={() => {
                  if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
                }}
                onLoadedMetadata={() => {
                  if (audioRef.current) setAudioDuration(audioRef.current.duration);
                }}
                onError={() => setAudioError(true)}
                preload="metadata"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => skip(-10)}
                  className="icon-btn h-7 w-7 border-transparent"
                  title="Back 10s"
                  aria-label="Back 10 seconds"
                >
                  <SkipBack size={12} />
                </button>
                <button
                  type="button"
                  onClick={togglePlay}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-hover"
                  title={isPlaying ? "Pause" : "Play"}
                  aria-label={isPlaying ? "Pause recording playback" : "Play recording"}
                >
                  {isPlaying ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => skip(10)}
                  className="icon-btn h-7 w-7 border-transparent"
                  title="Forward 10s"
                  aria-label="Forward 10 seconds"
                >
                  <SkipForward size={12} />
                </button>

                <span className="text-footnote font-mono text-text-muted w-10 text-center shrink-0">
                  {formatSeconds(currentTime)}
                </span>

                <input
                  type="range"
                  min={0}
                  max={audioDuration || 0}
                  step={0.1}
                  value={currentTime}
                  onChange={handleSeek}
                  className="flex-1 h-1 accent-accent cursor-pointer"
                  aria-label="Recording playback position"
                />

                <span className="text-footnote font-mono text-text-muted w-10 text-center shrink-0">
                  {formatSeconds(audioDuration)}
                </span>

                <button
                  type="button"
                  onClick={cycleSpeed}
                  className="h-7 min-w-9 rounded border border-border bg-bg-tertiary px-1 font-mono text-footnote text-text-secondary transition-colors hover:text-accent"
                  title="Playback speed"
                  aria-label="Playback speed"
                >
                  {playbackSpeed}x
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Speakers Tab — the single identification/rename surface ── */}
      {drawerTab === "speakers" && (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <IdentifySpeakersPanel meetingId={meetingId} initialSpeaker={speakerFocus} />
        </div>
      )}
    </aside>
  );
}

function parseSegments(transcript: Transcript | null | undefined): TranscriptSegment[] {
  if (!transcript?.segments) return [];
  try {
    return JSON.parse(transcript.segments);
  } catch {
    return [];
  }
}

function formatMs(ms: number, shortFormat: boolean): string {
  const totalSec = Math.floor(ms / 1000);
  if (shortFormat) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatSeconds(s: number): string {
  if (!isFinite(s) || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function highlightSearch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${escapeRegex(query)})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-accent/50 text-white rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
