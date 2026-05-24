import { useEffect } from "react";
import { CheckCircle2, FileText, Sparkles, Timer, Users } from "lucide-react";
import { IdentifySpeakersPanel } from "./IdentifySpeakersPanel";

interface PostRecordingScreenProps {
  meetingId: string;
  duration: number;          // seconds
  segmentCount: number;
  speakerCount: number | null;
  onEnhance: () => void;
  onReviewTranscript: () => void;
  onDismiss: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return "< 1 min";
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

export function PostRecordingScreen({
  meetingId,
  duration,
  segmentCount,
  speakerCount,
  onEnhance,
  onReviewTranscript,
  onDismiss,
}: PostRecordingScreenProps) {
  // 20-second auto-dismiss
  useEffect(() => {
    const id = setTimeout(onDismiss, 20_000);
    return () => clearTimeout(id);
  }, [onDismiss]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-8 animate-fade-in sm:px-6 sm:py-12">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
          <CheckCircle2 size={24} />
        </div>

        <div className="space-y-1 text-center">
          <h2 className="text-xl font-semibold text-text-primary">Recording saved</h2>
          <p className="text-sm text-text-muted">Review the transcript now or generate AI notes from this recording.</p>
        </div>

        {/* Stats */}
        <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="flex h-16 items-center gap-2 rounded-lg border border-border/70 bg-bg-secondary/45 px-3">
            <Timer size={15} className="shrink-0 text-text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{formatDuration(duration)}</p>
              <p className="text-[11px] text-text-muted">Duration</p>
            </div>
          </div>
          <div className="flex h-16 items-center gap-2 rounded-lg border border-border/70 bg-bg-secondary/45 px-3">
            <FileText size={15} className="shrink-0 text-text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{segmentCount}</p>
              <p className="text-[11px] text-text-muted">Transcript segments</p>
            </div>
          </div>
          <div className="flex h-16 items-center gap-2 rounded-lg border border-border/70 bg-bg-secondary/45 px-3">
            <Users size={15} className="shrink-0 text-text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{speakerCount != null && speakerCount > 0 ? speakerCount : "None"}</p>
              <p className="text-[11px] text-text-muted">Speakers detected</p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={onEnhance}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-semibold text-white transition-colors"
            style={{ background: "var(--color-accent)" }}
          >
            <Sparkles size={15} />
            Enhance Notes
          </button>
          <button
            type="button"
            onClick={onReviewTranscript}
            className="flex h-10 flex-1 items-center justify-center rounded-lg border border-border px-4 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            Review Transcript
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-10 items-center justify-center rounded-lg px-3 text-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
          >
            Back to notes
          </button>
        </div>

        {speakerCount != null && speakerCount > 1 && (
          <div className="w-full max-w-xl">
            <IdentifySpeakersPanel meetingId={meetingId} />
          </div>
        )}
      </div>
    </div>
  );
}
