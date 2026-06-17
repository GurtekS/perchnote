import { useState } from "react";
import { MessageCircleQuestion, Sparkles, X } from "lucide-react";
import { useUIStore } from "../../stores/uiStore";

interface Props {
  /** Live transcript segment count — the pills wait for a little context. */
  segmentCount: number;
  /** Mid-meeting recap (plan v9 #5): resolves to the recap text. Absent
   *  when no AI provider is configured — the pills simply don't exist. */
  catchMeUp?: () => Promise<string>;
}

/** Minimum transcribed segments before a recap could say anything useful. */
const MIN_SEGMENTS = 3;

/**
 * "Catch me up" + mid-meeting "Ask AI" pills, plus the transient recap card.
 *
 * Rendered by MeetingView at the recording-pane level — overlaying whichever
 * pane is visible — so the pills exist in BOTH the default Notes view and the
 * Live Transcript view. They used to live inside LiveTranscriptView only,
 * which made catch-me-up invisible to anyone who stayed on the Notes tab —
 * exactly the late joiner the feature was built for (deep review P2).
 */
export function RecordingAssist({ segmentCount, catchMeUp }: Props) {
  // Catch-me-up card: transient by design — it never touches the notes.
  const [recap, setRecap] = useState<string | null>(null);
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapError, setRecapError] = useState<string | null>(null);

  if (!catchMeUp) return null;

  const requestRecap = async () => {
    if (recapLoading) return;
    setRecapLoading(true);
    setRecapError(null);
    try {
      setRecap(await catchMeUp());
    } catch (e) {
      setRecapError(String(e));
    } finally {
      setRecapLoading(false);
    }
  };

  return (
    <>
      {/* Catch me up (plan v9 #5): joined late, zoned out, back from a
          break — one click recaps what's been said so far. */}
      {segmentCount >= MIN_SEGMENTS && (
        <div className="absolute right-4 top-3 z-10 flex items-center gap-1.5">
          {/* Ask AI works mid-meeting (plan v11 #2): same overlay as ⌘J,
              surfaced here so people learn it exists while it's useful. */}
          <button
            type="button"
            onClick={() => useUIStore.getState().toggleAskAI()}
            className="flex items-center gap-1.5 rounded-full border border-border bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-secondary shadow-lg transition-colors hover:text-text-primary"
            title="Ask about this meeting so far (⌘J)"
          >
            <MessageCircleQuestion size={12} />
            Ask AI
          </button>
          <button
            type="button"
            onClick={requestRecap}
            disabled={recapLoading}
            className="flex items-center gap-1.5 rounded-full border border-border bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-secondary shadow-lg transition-colors hover:text-text-primary disabled:opacity-60"
          >
            <Sparkles size={12} className={recapLoading ? "animate-pulse" : ""} />
            {recapLoading ? "Catching up…" : "Catch me up"}
          </button>
        </div>
      )}
      {(recap !== null || recapError !== null) && (
        <div
          role="region"
          aria-label="Catch-up recap"
          className="absolute inset-x-4 top-12 z-20 max-h-[60%] overflow-y-auto glass-float rounded-xl p-4"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-footnote font-semibold uppercase tracking-wider text-text-muted">
              {recapError ? "Couldn't catch you up" : "While you were away"}
            </span>
            <button
              type="button"
              onClick={() => {
                setRecap(null);
                setRecapError(null);
              }}
              aria-label="Dismiss recap"
              className="text-text-muted hover:text-text-primary"
            >
              <X size={12} />
            </button>
          </div>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-primary">
            {recapError ?? recap}
          </p>
          <p className="mt-2 text-footnote text-text-muted">
            Not saved anywhere. Dismiss when you're caught up.
          </p>
        </div>
      )}
    </>
  );
}
