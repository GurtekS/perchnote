import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, FileText, Download, BarChart3, Search, Pencil, Trash2, X, AlertTriangle, RefreshCw, Users, Layers, Volume2, Monitor, Phone } from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { ipc, Transcript } from "../../lib/ipc";
import { LiveTranscript } from "./LiveTranscript";
import { AudioPlayer } from "./AudioPlayer";
import { toast } from "../../stores/toastStore";

interface WordTimestamp {
  word: string;
  start_ms: number;
  end_ms: number;
}

interface TranscriptSegment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  confidence?: number | null;
  words?: WordTimestamp[] | null;
  /** True when this segment overlaps in time with the previous segment */
  is_overlap?: boolean;
  /** Speaker detection confidence (0.0-1.0) */
  speaker_confidence?: number;
}

const SPEAKER_COLORS = [
  "text-blue-400",
  "text-emerald-400",
  "text-amber-400",
  "text-purple-400",
  "text-pink-400",
  "text-cyan-400",
];

const SPEAKER_BG_COLORS = [
  "bg-blue-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-purple-400",
  "bg-pink-400",
  "bg-cyan-400",
];

function getSpeakerColor(speaker: string): string {
  const num = parseInt(speaker.replace(/\D/g, ""), 10) || 0;
  return SPEAKER_COLORS[(num - 1) % SPEAKER_COLORS.length];
}

function getSpeakerBgColor(speaker: string): string {
  const num = parseInt(speaker.replace(/\D/g, ""), 10) || 0;
  return SPEAKER_BG_COLORS[(num - 1) % SPEAKER_BG_COLORS.length];
}

interface TranscriptViewProps {
  meetingId: string;
  liveSegments: TranscriptSegment[];
  isRecording: boolean;
  transcriptionStatus: string | null;
  /** Calendar attendees to link speakers to */
  attendees?: string[];
}

interface SpeakerStats {
  name: string;
  segments: number;
  words: number;
  durationMs: number;
  percentage: number;
}

export function TranscriptView({
  meetingId,
  liveSegments,
  isRecording,
  transcriptionStatus,
  attendees = [],
}: TranscriptViewProps) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copiedSegmentIdx, setCopiedSegmentIdx] = useState<number | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // Re-diarize state
  const [isRediarizing, setIsRediarizing] = useState(false);
  // Speaker-to-attendee mapping UI
  const [showAttendeeMapping, setShowAttendeeMapping] = useState(false);
  // Items 137, 138: Audio playback state
  const [showPlayer, setShowPlayer] = useState(false);
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0);
  const [seekToMs, setSeekToMs] = useState<number | undefined>(undefined);
  // Counter to allow seeking to the same timestamp twice in a row
  const [seekCounter, setSeekCounter] = useState(0);

  /** Click a segment timestamp to seek the audio player */
  const handleSeekToSegment = useCallback((startMs: number) => {
    setShowPlayer(true);
    setSeekToMs(startMs);
    setSeekCounter((c) => c + 1);
  }, []);

  const { data: transcript } = useQuery({
    queryKey: ["transcript", meetingId],
    queryFn: () => ipc.getTranscriptByMeeting(meetingId),
    enabled: !isRecording,
  });

  const { data: speakerLabels = [], refetch: refetchLabels } = useQuery({
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

  /** Map speaker keys to their participant type */
  const speakerParticipantTypeMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const sl of speakerLabels) {
      map[sl.speaker_key] = sl.participant_type || "in-room";
    }
    return map;
  }, [speakerLabels]);

  const getDisplayName = useCallback((speaker: string | null) => {
    if (!speaker) return "Unknown";
    return speakerLabelMap[speaker] || speaker;
  }, [speakerLabelMap]);

  if (isRecording) {
    return <LiveTranscript segments={liveSegments} status={transcriptionStatus} />;
  }

  const segments = parseSegments(transcript);
  const displaySegments = segments.length > 0 ? segments : liveSegments;

  // Filter by speaker
  const filteredSegments = useMemo(() => {
    let segs = displaySegments;
    if (speakerFilter) {
      segs = segs.filter((s) => s.speaker === speakerFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      segs = segs.filter((s) => s.text.toLowerCase().includes(q));
    }
    return segs;
  }, [displaySegments, speakerFilter, searchQuery]);

  // Calculate speaker statistics
  const speakerStats = useMemo((): SpeakerStats[] => {
    if (displaySegments.length === 0) return [];

    const stats: Record<string, { segments: number; words: number; durationMs: number }> = {};
    let totalDuration = 0;

    for (const seg of displaySegments) {
      const speaker = seg.speaker || "Unknown";
      if (!stats[speaker]) {
        stats[speaker] = { segments: 0, words: 0, durationMs: 0 };
      }
      stats[speaker].segments++;
      stats[speaker].words += seg.text.split(/\s+/).filter(Boolean).length;
      const dur = seg.end_ms - seg.start_ms;
      stats[speaker].durationMs += dur;
      totalDuration += dur;
    }

    return Object.entries(stats)
      .map(([name, s]) => ({
        name,
        ...s,
        percentage: totalDuration > 0 ? Math.round((s.durationMs / totalDuration) * 100) : 0,
      }))
      .sort((a, b) => b.durationMs - a.durationMs);
  }, [displaySegments]);

  // Timeline data
  const timelineData = useMemo(() => {
    if (displaySegments.length === 0) return null;
    const totalMs = displaySegments[displaySegments.length - 1]?.end_ms || 1;
    return displaySegments.map((seg) => ({
      speaker: seg.speaker || "Unknown",
      startPct: (seg.start_ms / totalMs) * 100,
      widthPct: ((seg.end_ms - seg.start_ms) / totalMs) * 100,
    }));
  }, [displaySegments]);

  const totalWords = displaySegments.reduce(
    (acc, s) => acc + s.text.split(/\s+/).filter(Boolean).length,
    0
  );

  const uniqueSpeakers = useMemo(() => {
    const s = new Set<string>();
    for (const seg of displaySegments) {
      if (seg.speaker) s.add(seg.speaker);
    }
    return Array.from(s);
  }, [displaySegments]);

  // Count overlapping segments
  const overlapCount = useMemo(() => {
    return displaySegments.filter((s) => s.is_overlap).length;
  }, [displaySegments]);

  if (displaySegments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted p-8">
        <FileText size={32} className="mb-3 opacity-30" />
        <p className="text-sm font-medium">No transcript available</p>
        <p className="text-xs mt-1">Record a meeting to generate a transcript.</p>
      </div>
    );
  }

  const handleCopy = async () => {
    const text = filteredSegments
      .map((s) => {
        const name = getDisplayName(s.speaker);
        return s.speaker ? `${name}: ${s.text}` : s.text;
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = () => {
    const lines = filteredSegments.map((s) => {
      const time = formatMs(s.start_ms);
      const name = getDisplayName(s.speaker);
      const speaker = s.speaker ? `[${name}] ` : "";
      return `[${time}] ${speaker}${s.text}`;
    });
    const text = lines.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transcript-${meetingId.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Transcript exported");
  };

  const handleCopySegment = async (seg: TranscriptSegment, idx: number) => {
    const name = getDisplayName(seg.speaker);
    const text = seg.speaker ? `${name}: ${seg.text}` : seg.text;
    await navigator.clipboard.writeText(text);
    setCopiedSegmentIdx(idx);
    setTimeout(() => setCopiedSegmentIdx(null), 2000);
  };

  const handleDeleteSegment = async (seg: TranscriptSegment) => {
    const originalIdx = displaySegments.findIndex((s) => s === seg);
    if (originalIdx === -1) return;
    try {
      await ipc.deleteTranscriptSegment(meetingId, originalIdx);
      queryClient.invalidateQueries({ queryKey: ["transcript", meetingId] });
    } catch (e) {
      toast.error(`Failed to delete segment: ${e}`);
    }
  };

  const handleSaveSpeakerName = async (speakerKey: string) => {
    if (editName.trim()) {
      await ipc.upsertSpeakerLabel(meetingId, speakerKey, editName.trim());
      refetchLabels();
      toast.success(`Speaker renamed to "${editName.trim()}"`);
    }
    setEditingSpeaker(null);
    setEditName("");
  };

  // Map a speaker to a calendar attendee
  const handleMapSpeakerToAttendee = async (speakerKey: string, attendeeName: string) => {
    if (attendeeName) {
      await ipc.upsertSpeakerLabel(meetingId, speakerKey, attendeeName);
      refetchLabels();
      toast.success(`${speakerKey} mapped to ${attendeeName}`);
    }
  };

  // Re-analyze speakers
  const handleRediarize = async () => {
    setIsRediarizing(true);
    try {
      await ipc.rediarizeTranscript(meetingId);
      queryClient.invalidateQueries({ queryKey: ["transcript", meetingId] });
      toast.success("Speakers re-analyzed successfully");
    } catch (e) {
      toast.error(`Re-analysis failed: ${e}`);
    } finally {
      setIsRediarizing(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted">
            {filteredSegments.length} segment{filteredSegments.length !== 1 ? "s" : ""} &middot; {totalWords} words
            {overlapCount > 0 && (
              <span className="ml-1 text-amber-400" title={`${overlapCount} overlapping speech segment(s)`}>
                &middot; {overlapCount} overlap{overlapCount !== 1 ? "s" : ""}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Re-analyze Speakers button */}
          <button
            onClick={handleRediarize}
            disabled={isRediarizing}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
            title="Re-analyze speaker assignments using accumulated profile data"
          >
            <RefreshCw size={10} className={isRediarizing ? "animate-spin" : ""} />
            Re-analyze Speakers
          </button>
          {/* Map speakers to attendees */}
          {attendees.length > 0 && (
            <button
              onClick={() => setShowAttendeeMapping(!showAttendeeMapping)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                showAttendeeMapping
                  ? "text-accent bg-accent/10"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
              }`}
              title="Map speakers to calendar attendees"
            >
              <Users size={10} />
              Map Attendees
            </button>
          )}
          <button
            onClick={() => setShowTimeline(!showTimeline)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
              showTimeline
                ? "text-accent bg-accent/10"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
            data-tooltip="Speaker timeline"
            title="Speaker timeline"
          >
            Timeline
          </button>
          <button
            onClick={() => setShowStats(!showStats)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
              showStats
                ? "text-accent bg-accent/10"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
            data-tooltip="Speaker statistics"
            title="Speaker statistics"
          >
            <BarChart3 size={10} />
            Stats
          </button>
          {/* Audio playback toggle */}
          <button
            onClick={() => setShowPlayer(!showPlayer)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
              showPlayer
                ? "text-accent bg-accent/10"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
            data-tooltip="Audio playback"
            title="Audio playback"
          >
            <Volume2 size={10} />
            Play
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            data-tooltip="Export transcript"
            title="Export transcript"
          >
            <Download size={10} />
            Export
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? "Copied" : "Copy all"}
          </button>
        </div>
      </div>

      {/* Items 137, 138: Audio Player */}
      {showPlayer && (
        <AudioPlayer
          meetingId={meetingId}
          onTimeUpdate={setPlaybackTimeMs}
          seekToMs={seekToMs}
          seekNonce={seekCounter}
        />
      )}

      {/* Speaker-to-Attendee Mapping Panel */}
      {showAttendeeMapping && attendees.length > 0 && (
        <div className="px-4 py-3 border-b border-border bg-bg-tertiary/50 space-y-2">
          <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">Map Speakers to Attendees</h4>
          <p className="text-[10px] text-text-muted">
            Link detected speakers to calendar attendees for named attribution.
          </p>
          {uniqueSpeakers.map((spk) => (
            <div key={spk} className="flex items-center gap-3">
              <span className={`text-xs font-medium w-24 ${getSpeakerColor(spk)} truncate`}>
                {spk}
              </span>
              <select
                value={speakerLabelMap[spk] || ""}
                onChange={(e) => handleMapSpeakerToAttendee(spk, e.target.value)}
                className="bg-bg-primary text-xs text-text-secondary rounded-lg border border-border px-2 py-1.5 focus:outline-none focus:border-accent flex-1 max-w-[200px]"
              >
                <option value="">-- Select attendee --</option>
                {attendees.map((att) => (
                  <option key={att} value={att}>{att}</option>
                ))}
              </select>
              {/* Participant type selector */}
              <select
                value={speakerParticipantTypeMap[spk] || "in-room"}
                onChange={async (e) => {
                  const displayName = speakerLabelMap[spk] || spk;
                  await ipc.upsertSpeakerLabel(meetingId, spk, displayName, undefined, e.target.value);
                  refetchLabels();
                }}
                className="bg-bg-primary text-[10px] text-text-secondary rounded-lg border border-border px-1.5 py-1.5 focus:outline-none focus:border-accent w-24"
              >
                <option value="in-room">In-Room</option>
                <option value="remote">Remote</option>
                <option value="phone">Phone</option>
              </select>
              {speakerLabelMap[spk] && (
                <span className="text-[10px] text-success">Mapped</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Speaker Timeline Visualization */}
      {showTimeline && timelineData && (
        <div className="px-4 py-3 border-b border-border bg-bg-tertiary/50">
          <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Speaker Timeline</h4>
          <div className="h-6 bg-bg-primary rounded-full overflow-hidden relative">
            {timelineData.map((seg, i) => (
              <div
                key={i}
                className={`absolute h-full ${getSpeakerBgColor(seg.speaker)} opacity-70`}
                style={{ left: `${seg.startPct}%`, width: `${Math.max(seg.widthPct, 0.2)}%` }}
                title={`${getDisplayName(seg.speaker)}`}
              />
            ))}
          </div>
          <div className="flex gap-3 mt-2">
            {uniqueSpeakers.map((s) => (
              <div key={s} className="flex items-center gap-1 text-[10px] text-text-muted">
                <span className={`w-2 h-2 rounded-full ${getSpeakerBgColor(s)}`} />
                {getDisplayName(s)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Speaker Stats Panel */}
      {showStats && speakerStats.length > 0 && (
        <div className="px-4 py-3 border-b border-border bg-bg-tertiary/50 space-y-2">
          <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">Speaker Breakdown</h4>
          {speakerStats.map((stat) => (
            <div key={stat.name} className="flex items-center gap-3">
              <span className={`text-xs font-medium w-24 ${getSpeakerColor(stat.name)} truncate`}>
                {getDisplayName(stat.name)}
              </span>
              <div className="flex-1 h-2 bg-bg-primary rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all"
                  style={{ width: `${stat.percentage}%` }}
                />
              </div>
              <span className="text-[11px] text-text-muted w-28 text-right">
                {stat.percentage}% &middot; {stat.words} words
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Search & Filter Bar */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 bg-bg-tertiary rounded-lg px-2 py-1.5">
          <Search size={12} className="text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search transcript..."
            className="bg-transparent text-xs text-text-primary focus:outline-none flex-1 placeholder:text-text-muted"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} className="text-text-muted hover:text-text-primary">
              <X size={10} />
            </button>
          )}
        </div>
        {uniqueSpeakers.length > 1 && (
          <select
            value={speakerFilter || ""}
            onChange={(e) => setSpeakerFilter(e.target.value || null)}
            className="bg-bg-tertiary text-xs text-text-secondary rounded-lg border-none px-2 py-1.5 focus:outline-none"
          >
            <option value="">All speakers</option>
            {uniqueSpeakers.map((s) => (
              <option key={s} value={s}>{getDisplayName(s)}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2 scroll-shadows">
        {filteredSegments.map((seg, i) => {
          const prevSpeaker = i > 0 ? filteredSegments[i - 1].speaker : null;
          const showSpeaker = seg.speaker && seg.speaker !== prevSpeaker;
          const displayName = getDisplayName(seg.speaker);
          // Format speaker confidence as percentage
          const speakerConfPct = seg.speaker_confidence != null
            ? Math.round(seg.speaker_confidence * 100)
            : null;

          // Highlight the current segment during playback
          const isCurrentPlayback = showPlayer &&
            playbackTimeMs >= seg.start_ms &&
            playbackTimeMs < seg.end_ms;

          return (
            <div
              key={i}
              className={`${showSpeaker ? "pt-2" : ""} ${
                isCurrentPlayback ? "bg-accent/10 rounded -mx-1 px-1" : ""
              }`}
            >
              {/* Overlapping speech indicator */}
              {seg.is_overlap && (
                <div className="flex items-center gap-1 mb-1">
                  <Layers size={10} className="text-amber-400" />
                  <span className="text-[10px] text-amber-400 font-medium">
                    Multiple speakers (overlapping speech)
                  </span>
                </div>
              )}
              {showSpeaker && (
                <div className={`text-xs font-medium mb-0.5 flex items-center gap-1 ${getSpeakerColor(seg.speaker!)}`}>
                  {/* Speaker avatar placeholder */}
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] text-white ${getSpeakerBgColor(seg.speaker!)}`}>
                    {displayName[0]?.toUpperCase()}
                  </span>
                  {editingSpeaker === seg.speaker ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSaveSpeakerName(seg.speaker!); if (e.key === "Escape") setEditingSpeaker(null); }}
                        className="bg-bg-tertiary text-xs text-text-primary px-1.5 py-0.5 rounded border border-accent w-24 focus:outline-none"
                        autoFocus
                      />
                      <button onClick={() => handleSaveSpeakerName(seg.speaker!)} className="text-accent"><Check size={10} /></button>
                    </div>
                  ) : (
                    <>
                      {displayName}
                      {/* Speaker confidence badge */}
                      {speakerConfPct != null && speakerConfPct > 0 && (
                        <span
                          className={`ml-1 text-[9px] px-1 py-0.5 rounded ${
                            speakerConfPct >= 70
                              ? "bg-emerald-500/20 text-emerald-400"
                              : speakerConfPct >= 40
                                ? "bg-amber-500/20 text-amber-400"
                                : "bg-red-500/20 text-red-400"
                          }`}
                          title={`Speaker detection confidence: ${speakerConfPct}%`}
                        >
                          {speakerConfPct}%
                        </span>
                      )}
                      {/* Participant type badge */}
                      {seg.speaker && speakerParticipantTypeMap[seg.speaker] && speakerParticipantTypeMap[seg.speaker] !== "in-room" && (
                        <ParticipantTypeBadge type={speakerParticipantTypeMap[seg.speaker]} />
                      )}
                      <button
                        onClick={() => { setEditingSpeaker(seg.speaker!); setEditName(displayName); }}
                        className="opacity-0 group-hover:opacity-100 hover:opacity-100 text-text-muted hover:text-text-secondary"
                        title="Rename speaker"
                      >
                        <Pencil size={8} />
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className={`flex items-start gap-2 group ${seg.is_overlap ? "border-l-2 border-amber-400/50 pl-2" : ""}`}>
                {/* Low-confidence warning indicator */}
                {seg.confidence != null && seg.confidence < 0.5 && (
                  <span
                    className="shrink-0 pt-0.5 text-warning"
                    title={`Low confidence: ${Math.round(seg.confidence * 100)}%`}
                  >
                    <AlertTriangle size={12} />
                  </span>
                )}
                <span className={`text-[13px] leading-relaxed flex-1 ${
                  seg.confidence != null && seg.confidence < 0.5
                    ? "text-warning/80"
                    : "text-text-primary"
                }`}>
                  {seg.text}
                </span>
                <div className="flex items-center gap-1 shrink-0 pt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleSeekToSegment(seg.start_ms)}
                    className="text-[10px] text-text-muted hover:text-accent cursor-pointer"
                    title="Play from here"
                  >
                    {formatMs(seg.start_ms)}
                  </button>
                  <button
                    onClick={() => handleCopySegment(seg, i)}
                    className="text-text-muted hover:text-text-primary cursor-pointer"
                    title="Copy segment"
                  >
                    {copiedSegmentIdx === i ? <Check size={10} className="text-accent" /> : <Copy size={10} />}
                  </button>
                  {!isRecording && (
                    <button
                      onClick={() => handleDeleteSegment(seg)}
                      className="text-text-muted hover:text-recording cursor-pointer"
                      title="Delete segment"
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Badge showing participant type (Remote, Phone) */
function ParticipantTypeBadge({ type }: { type: string }) {
  if (type === "in-room" || !type) return null;

  const config: Record<string, { label: string; icon: typeof Monitor; color: string }> = {
    remote: { label: "Remote", icon: Monitor, color: "bg-blue-500/20 text-blue-400" },
    phone: { label: "Phone", icon: Phone, color: "bg-orange-500/20 text-orange-400" },
  };

  const cfg = config[type];
  if (!cfg) return null;
  const Icon = cfg.icon;

  return (
    <span
      className={`ml-1 text-[9px] px-1 py-0.5 rounded inline-flex items-center gap-0.5 ${cfg.color}`}
      title={`Participant type: ${cfg.label}`}
    >
      <Icon size={8} />
      {cfg.label}
    </span>
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

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
