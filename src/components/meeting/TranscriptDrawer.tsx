import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  RefreshCw,
  Loader2,
  Mic,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, Transcript } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { IdentifySpeakersPanel } from "./IdentifySpeakersPanel";

interface TranscriptSegment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  speaker_confidence?: number;
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

const SPEAKER_HEX_COLORS = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#a78bfa",
  "#f472b6",
  "#22d3ee",
];

function getSpeakerBgColor(speaker: string): string {
  const num = parseInt(speaker.replace(/\D/g, ""), 10) || 0;
  return SPEAKER_COLORS[(num - 1) % SPEAKER_COLORS.length];
}

function getSpeakerHexColor(speaker: string): string {
  const num = parseInt(speaker.replace(/\D/g, ""), 10) || 0;
  return SPEAKER_HEX_COLORS[(num - 1) % SPEAKER_HEX_COLORS.length];
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

  // Speaker editing
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [editSpeakerName, setEditSpeakerName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [isReanalyzing, setIsReanalyzing] = useState(false);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [audioError, setAudioError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // Active segment ref for auto-scroll
  const activeSegRef = useRef<HTMLDivElement>(null);
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

  // Reset search when switching meetings
  useEffect(() => {
    setSearchQuery("");
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

  // Focus speaker edit input when editing starts
  useEffect(() => {
    if (editingSpeaker && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSpeaker]);

  const storedSegments = useMemo(() => parseSegments(transcript), [transcript]);

  // When recording, use live segments; otherwise use stored
  const segments = isRecording && liveSegments.length > 0 ? liveSegments : storedSegments;

  // Determine if meeting is under 1 hour
  const isUnderOneHour = useMemo(() => {
    if (segments.length === 0) return true;
    const lastEnd = segments[segments.length - 1]?.end_ms || 0;
    return lastEnd < 3600000;
  }, [segments]);

  // Filter by search
  const filteredSegments = useMemo(() => {
    if (!searchQuery.trim()) return segments;
    const q = searchQuery.toLowerCase();
    return segments.filter((s) => s.text.toLowerCase().includes(q));
  }, [segments, searchQuery]);

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

  // Auto-scroll to active segment
  useEffect(() => {
    if (isPlaying && activeSegRef.current) {
      activeSegRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeSegmentStart, isPlaying]);

  // Unique speakers with confidence stats for speakers tab
  const uniqueSpeakers = useMemo(() => {
    const countMap = new Map<string, number>();
    const confMap = new Map<string, number[]>();
    for (const seg of segments) {
      if (seg.speaker) {
        countMap.set(seg.speaker, (countMap.get(seg.speaker) || 0) + 1);
        if (seg.speaker_confidence !== undefined) {
          const arr = confMap.get(seg.speaker) || [];
          arr.push(seg.speaker_confidence);
          confMap.set(seg.speaker, arr);
        }
      }
    }
    return Array.from(countMap.entries()).map(([speaker, count]) => {
      const confs = confMap.get(speaker) || [];
      const avgConf = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
      return { speaker, count, avgConf };
    });
  }, [segments]);

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
      toast.error("Playback failed: " + String(e));
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
        toast.error("Playback failed: " + String(e));
      }
    }
  };

  // Re-analyze speakers
  const handleReanalyze = async () => {
    setIsReanalyzing(true);
    try {
      await ipc.rediarizeTranscript(meetingId);
      queryClient.invalidateQueries({ queryKey: ["transcript", meetingId] });
      toast.success("Speaker analysis updated");
    } catch (e) {
      toast.error("Re-analysis failed: " + String(e));
    } finally {
      setIsReanalyzing(false);
    }
  };

  // Speaker label editing
  const handleEditSpeaker = (speakerKey: string) => {
    setEditingSpeaker(speakerKey);
    setEditSpeakerName(getDisplayName(speakerKey));
  };

  const handleSaveSpeakerName = async (speakerKey: string) => {
    const name = editSpeakerName.trim();
    setEditingSpeaker(null);
    if (name && name !== getDisplayName(speakerKey)) {
      await ipc.upsertSpeakerLabel(meetingId, speakerKey, name);
      queryClient.invalidateQueries({ queryKey: ["speakerLabels", meetingId] });
      toast.success("Speaker name updated");
    }
  };

  if (!isOpen) return null;

  const isLive = isRecording && liveSegments.length > 0;

  return (
    <aside className="drawer-enter flex h-full w-[min(400px,100%)] min-w-[320px] shrink-0 flex-col border-l border-border bg-bg-primary" aria-label="Transcript drawer">
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
            onClick={() => setDrawerTab("speakers")}
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
          {/* Identify speakers collapsible */}
          <details className="px-4 py-2 border-b border-border" open={false}>
            <summary className="text-xs text-text-muted cursor-pointer select-none">Identify speakers</summary>
            <div className="pt-2">
              <IdentifySpeakersPanel meetingId={meetingId} />
            </div>
          </details>

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
                  placeholder="Search transcript..."
                  className="bg-transparent text-xs text-text-primary focus:outline-none flex-1 placeholder:text-text-muted"
                />
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
                <div className="text-[10px] text-text-muted mt-1">
                  {filteredSegments.length} result{filteredSegments.length !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}

          {/* Live indicator banner */}
          {isLive && (
            <div className="px-4 py-1.5 border-b border-border bg-recording/5 shrink-0 flex items-center gap-1.5">
              <span className="flex h-1.5 w-1.5 rounded-full bg-recording animate-pulse" />
              <span className="text-[11px] font-medium text-recording">Live</span>
              <span className="text-[11px] text-text-muted ml-1">{liveSegments.length} segment{liveSegments.length !== 1 ? "s" : ""}</span>
            </div>
          )}

          {/* Transcript content */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5">
            {segments.length === 0 ? (
              <div className="empty-state h-full px-4 py-12">
                <div className="empty-state-icon">
                  <Mic size={24} />
                </div>
                <p className="text-sm font-medium">
                  {isRecording ? "Listening..." : meetingStatus === "complete" ? "No transcript" : "No transcript yet"}
                </p>
                <p className="text-xs text-center max-w-[200px] leading-relaxed">
                  {isRecording
                    ? "Transcript will appear here as you speak."
                    : meetingStatus === "complete"
                    ? "No transcript was captured for this meeting."
                    : "Record this meeting to generate a transcript."}
                </p>
              </div>
            ) : (
              filteredSegments.map((seg, i) => {
                const prevSpeaker = i > 0 ? filteredSegments[i - 1].speaker : null;
                const showSpeaker = seg.speaker !== prevSpeaker;
                const isActive = !isLive && seg.start_ms === activeSegmentStart;

                return (
                  <div
                    key={i}
                    ref={isActive ? activeSegRef : undefined}
                    className={showSpeaker ? "pt-3" : ""}
                  >
                    {showSpeaker && seg.speaker && (
                      <div className="flex items-center gap-2 mb-1">
                        {/* Speaker pill — click to edit */}
                        <button
                          type="button"
                          onClick={() => handleEditSpeaker(seg.speaker!)}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-white ${getSpeakerBgColor(seg.speaker)} hover:opacity-80 transition-opacity`}
                          title="Click to rename speaker"
                          aria-label={`Rename speaker ${getDisplayName(seg.speaker)}`}
                        >
                          {getDisplayName(seg.speaker)}
                          <Pencil size={8} className="opacity-60" />
                        </button>
                        <button
                          type="button"
                          onClick={() => seekToTimestamp(seg.start_ms)}
                          className="text-[10px] text-text-muted hover:text-accent transition-colors cursor-pointer"
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
                      } ${isActive ? "bg-accent/8" : ""}`}
                    >
                      {!isLive && (
                        <Play
                          size={10}
                          className="mt-1 shrink-0 text-accent opacity-0 transition-opacity group-hover:opacity-50 group-focus-within:opacity-50"
                        />
                      )}
                      <p className="text-[13px] text-text-primary leading-relaxed flex-1">
                        {searchQuery
                          ? highlightSearch(seg.text, searchQuery)
                          : seg.text}
                      </p>
                      {!showSpeaker && !isLive && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); seekToTimestamp(seg.start_ms); }}
                          className="shrink-0 cursor-pointer pt-0.5 text-[10px] text-text-muted opacity-0 transition-opacity hover:text-accent focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                          aria-label={`Play from ${formatMs(seg.start_ms, isUnderOneHour)}`}
                        >
                          {formatMs(seg.start_ms, isUnderOneHour)}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {isLive && <div ref={liveBottomRef} />}
          </div>

          {/* Playback unavailable notice */}
          {audioSrc && audioError && !isLive && (
            <div className="border-t border-border px-4 py-2 shrink-0 text-[11px] text-text-muted flex items-center gap-2">
              <span>Recording not playable in this format</span>
            </div>
          )}

          {/* Mini audio player (only for stored transcript) */}
          {audioSrc && !audioError && !isLive && (
            <div className="border-t border-border px-4 py-2.5 shrink-0" style={{ background: "var(--popup-bg)" }}>
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

                <span className="text-[10px] font-mono text-text-muted w-10 text-center shrink-0">
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

                <span className="text-[10px] font-mono text-text-muted w-10 text-center shrink-0">
                  {formatSeconds(audioDuration)}
                </span>

                <button
                  type="button"
                  onClick={cycleSpeed}
                  className="h-7 min-w-9 rounded border border-border bg-bg-tertiary px-1 font-mono text-[10px] text-text-secondary transition-colors hover:text-accent"
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

      {/* ── Speakers Tab ── */}
      {drawerTab === "speakers" && (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {uniqueSpeakers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-1">
              <Users size={24} className="opacity-30 mb-1" />
              <p className="text-sm">No speakers detected</p>
              <p className="text-xs mt-0.5">Speakers appear after transcription.</p>
              {!isRecording && (
                <button
                  type="button"
                  onClick={handleReanalyze}
                  disabled={isReanalyzing}
                  className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
                >
                  {isReanalyzing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Re-analyze speakers
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                  {uniqueSpeakers.length} Speaker{uniqueSpeakers.length !== 1 ? "s" : ""}
                </p>
                {!isRecording && (
                  <button
                    type="button"
                    onClick={handleReanalyze}
                    disabled={isReanalyzing}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-border text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50"
                    title="Re-analyze speaker detection"
                  >
                    {isReanalyzing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                    Re-analyze
                  </button>
                )}
              </div>
              {uniqueSpeakers.map(({ speaker, count, avgConf }) => {
                const isEditing = editingSpeaker === speaker;
                const displayName = getDisplayName(speaker);
                const hexColor = getSpeakerHexColor(speaker);
                const confPct = avgConf !== null ? Math.round(avgConf * 100) : null;
                const confColor = confPct === null
                  ? "text-text-muted"
                  : confPct >= 70 ? "text-accent" : confPct >= 40 ? "text-warning" : "text-recording";

                return (
                  <div
                    key={speaker}
                    className="flex items-center gap-3 p-3 rounded-lg border"
                    style={{ background: "var(--glass-search-bg)", borderColor: "var(--glass-search-border)" }}
                  >
                    {/* Color dot */}
                    <div
                      className="w-3 h-3 rounded-full shrink-0 mt-0.5"
                      style={{ background: hexColor }}
                    />

                    {/* Name + edit */}
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editSpeakerName}
                          onChange={(e) => setEditSpeakerName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveSpeakerName(speaker);
                            if (e.key === "Escape") setEditingSpeaker(null);
                          }}
                          onBlur={() => handleSaveSpeakerName(speaker)}
                          className="w-full text-sm bg-bg-tertiary text-text-primary rounded px-2 py-0.5 border border-accent focus:outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleEditSpeaker(speaker)}
                          className="text-sm font-medium text-text-primary hover:text-accent transition-colors text-left group flex items-center gap-1.5 w-full"
                          title="Click to rename"
                        >
                          <span className="truncate">{displayName}</span>
                          <Pencil size={10} className="shrink-0 opacity-0 group-hover:opacity-50 transition-opacity" />
                        </button>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-[10px] text-text-muted">{speaker}</p>
                        {confPct !== null && (
                          <span className={`text-[10px] font-mono ${confColor}`}>
                            {confPct}% conf
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Segment count */}
                    <span className="text-[11px] text-text-muted bg-bg-tertiary rounded-full px-2 py-0.5 shrink-0">
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
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
