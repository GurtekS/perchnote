import { useEffect, useRef } from "react";

export interface LiveSegment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
}

interface Props {
  segments: LiveSegment[];
}

export function LiveTranscriptView({ segments }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bottomRef.current) return;
    const scrollContainer = bottomRef.current.parentElement?.parentElement as HTMLElement | null;
    if (scrollContainer) {
      const nearBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 200;
      if (nearBottom) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    } else {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [segments.length]);

  if (segments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted gap-2 py-16">
        <span className="relative flex h-2.5 w-2.5 mr-1">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-recording opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-recording" />
        </span>
        <p className="text-sm">Transcript will appear here as you speak...</p>
      </div>
    );
  }

  return (
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
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium text-white bg-accent/80">
                  {seg.speaker}
                </span>
                <span className="text-[10px] text-text-muted font-mono">{timeStr}</span>
              </div>
            )}
            <p className="text-[13px] text-text-primary leading-relaxed">{seg.text}</p>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
