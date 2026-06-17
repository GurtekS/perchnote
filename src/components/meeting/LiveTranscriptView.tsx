import { memo, useEffect, useRef, useState } from "react";
import { ArrowDown, Quote } from "lucide-react";

export interface LiveSegment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
}

interface Props {
  segments: LiveSegment[];
  /** Insert this line into the notes as a timestamped quote (capture 8). */
  onQuote?: (seg: LiveSegment) => void;
}

/** The live feed owns its scroller (it used to grope for an ancestor via
 *  parentElement chains). Follows the tail while you're at the bottom;
 *  scrolling up pauses following and shows a "Latest" pill to resume —
 *  the standard live-feed recovery affordance (plan v7 capture 5).
 *
 *  memo: this stays mounted (hidden) behind the notes editor while
 *  recording, and MeetingView re-renders every second from its elapsed
 *  tick — without memo every tick reconciled the full segment list
 *  (QA audit finding 6).
 *
 *  The catch-me-up / Ask AI pills used to live here too — they moved to
 *  RecordingAssist, rendered by MeetingView over BOTH recording panes, so
 *  the default Notes view gets them as well (deep review P2). */
export const LiveTranscriptView = memo(function LiveTranscriptView({
  segments,
  onQuote,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [followLive, setFollowLive] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followLive) el.scrollTop = el.scrollHeight;
  }, [segments.length, followLive]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setFollowLive(nearBottom);
  };

  const jumpToLatest = () => {
    setFollowLive(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="relative h-full">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        {segments.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted gap-2 py-16">
            <span className="relative flex h-2.5 w-2.5 mr-1">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-recording opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-recording" />
            </span>
            <p className="text-sm">Transcript will appear here as you speak...</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-6 py-5 space-y-3">
            {segments.map((seg, i) => {
              const prevSpeaker = i > 0 ? segments[i - 1].speaker : null;
              const showSpeaker = seg.speaker !== prevSpeaker;
              const offsetMs = seg.start_ms;
              const m = Math.floor(offsetMs / 60000);
              const s = Math.floor((offsetMs % 60000) / 1000);
              const timeStr = `${m}:${s.toString().padStart(2, "0")}`;

              return (
                <div key={i} className={showSpeaker ? "pt-2" : ""}>
                  {showSpeaker && seg.speaker && (
                    <div className="flex items-center gap-2 mb-1">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-caption font-medium text-white bg-accent/80">
                        {seg.speaker}
                      </span>
                      <span className="text-footnote text-text-muted font-mono">{timeStr}</span>
                    </div>
                  )}
                  <div className="group flex items-start gap-2">
                    <p className="flex-1 text-body-sm text-text-primary leading-relaxed">{seg.text}</p>
                    {onQuote && (
                      <button
                        type="button"
                        onClick={() => onQuote(seg)}
                        aria-label="Quote this line into your notes"
                        title="Quote into notes (latest line: ⌘⇧D)"
                        className="shrink-0 pt-0.5 text-text-muted opacity-0 transition-opacity hover:text-accent focus:opacity-100 group-hover:opacity-100"
                      >
                        <Quote size={11} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!followLive && segments.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-secondary shadow-lg transition-colors hover:text-text-primary"
        >
          <ArrowDown size={12} />
          Latest
        </button>
      )}
    </div>
  );
});
