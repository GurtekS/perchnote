import { useEffect, useState } from "react";
import { CheckCircle2, FileText, Loader2, Sparkles, Timer, Users } from "lucide-react";
import { IdentifySpeakersPanel } from "./IdentifySpeakersPanel";

interface PostRecordingScreenProps {
  meetingId: string;
  duration: number;          // seconds
  segmentCount: number;
  speakerCount: number | null;
  /** Instant recap will run (or is running) for this recording: the setting
   *  is on, a provider is configured, and there's a transcript to enhance. */
  autoEnhanceExpected?: boolean;
  /** An enhance run — manual or the background instant recap — is in flight. */
  isEnhancing?: boolean;
  /** Generated notes already exist for this meeting. */
  isEnhanced?: boolean;
  onEnhance: () => void;
  onReviewTranscript: () => void;
  onDismiss: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return "< 1 min";
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

/** Instant recap should start within a couple seconds of stop (once the
 *  transcript finishes draining). If we're still waiting well past that with
 *  no active run, it likely failed — the background run logs and emits no
 *  failure event, so a timeout is the only signal we get. Falling back means
 *  offering the manual Generate button rather than spinning forever. */
const AUTO_FALLBACK_MS = 45_000;

export function PostRecordingScreen({
  meetingId,
  duration,
  segmentCount,
  speakerCount,
  autoEnhanceExpected = false,
  isEnhancing = false,
  isEnhanced = false,
  onEnhance,
  onReviewTranscript,
  onDismiss,
}: PostRecordingScreenProps) {
  // Instant recap was expected but never produced notes and isn't running —
  // treat as failed and fall back to a manual Generate.
  const [pendingTimedOut, setPendingTimedOut] = useState(false);
  useEffect(() => {
    if (isEnhanced || isEnhancing || !autoEnhanceExpected) return;
    const id = setTimeout(() => setPendingTimedOut(true), AUTO_FALLBACK_MS);
    return () => clearTimeout(id);
  }, [isEnhanced, isEnhancing, autoEnhanceExpected]);

  // Notes are being written for us right now (an active run) or are imminent
  // (expected, not yet started, not timed out). Either way the manual Enhance
  // button would only duplicate the work — so we wait instead.
  const awaitingAuto = autoEnhanceExpected && !pendingTimedOut;
  const generating = !isEnhanced && (isEnhancing || awaitingAuto);
  const ready = isEnhanced;

  // 20-second auto-dismiss — cancelled the moment the user interacts, so the
  // screen never vanishes mid-read or mid-click. Suspended while notes are
  // generating so the screen waits to show "Notes ready" instead of yanking
  // the user to an empty editor.
  const [autoDismiss, setAutoDismiss] = useState(true);
  useEffect(() => {
    if (!autoDismiss || generating) return;
    const id = setTimeout(onDismiss, 20_000);
    return () => clearTimeout(id);
  }, [onDismiss, autoDismiss, generating]);

  const heading = ready
    ? "Notes ready"
    : "Recording saved";
  const subtext = segmentCount === 0
    ? "Nothing was transcribed. The meeting may have been silent, or transcription wasn't running (check the transcription model in Settings → Audio). The audio is saved and can be re-transcribed."
    : ready
    ? "Your AI notes are ready. Review or edit them."
    : generating
    ? "Writing your AI notes automatically. They'll be ready in a moment."
    : pendingTimedOut
    ? "Automatic notes didn't finish. You can generate them now."
    : "Review the transcript now or generate AI notes from this recording.";

  return (
    <div
      className="flex-1 overflow-y-auto px-4 py-8 animate-fade-in sm:px-6 sm:py-12"
      onPointerDownCapture={() => setAutoDismiss(false)}
      onKeyDownCapture={() => setAutoDismiss(false)}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
          {generating ? <Loader2 size={24} className="animate-spin" /> : <CheckCircle2 size={24} />}
        </div>

        <div className="space-y-1 text-center">
          <h2 className="text-xl font-semibold text-text-primary">{heading}</h2>
          <p className="text-sm text-text-muted">{subtext}</p>
        </div>

        {/* Stats */}
        <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="card flex h-16 items-center gap-2 px-3">
            <Timer size={15} className="shrink-0 text-text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{formatDuration(duration)}</p>
              <p className="text-caption text-text-muted">Duration</p>
            </div>
          </div>
          <div className="card flex h-16 items-center gap-2 px-3">
            <FileText size={15} className="shrink-0 text-text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{segmentCount}</p>
              <p className="text-caption text-text-muted">Transcript segments</p>
            </div>
          </div>
          <div className="card flex h-16 items-center gap-2 px-3">
            <Users size={15} className="shrink-0 text-text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{speakerCount != null && speakerCount > 0 ? speakerCount : "None"}</p>
              <p className="text-caption text-text-muted">Speakers detected</p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
          {generating ? (
            // Instant recap owns the notes right now — don't offer a manual
            // run that would duplicate it. A non-actionable status, not a button.
            <div
              className="btn btn-secondary btn-lg flex-1 cursor-default font-semibold opacity-90"
              role="status"
              aria-live="polite"
            >
              <Loader2 size={15} className="animate-spin" />
              Generating notes…
            </div>
          ) : ready ? (
            <button
              type="button"
              onClick={onDismiss}
              className="btn btn-primary btn-lg flex-1 font-semibold"
            >
              <FileText size={15} />
              View notes
            </button>
          ) : (
            segmentCount > 0 && (
              <button
                type="button"
                onClick={onEnhance}
                className="btn btn-primary btn-lg flex-1 font-semibold"
              >
                <Sparkles size={15} />
                {pendingTimedOut ? "Generate notes" : "Enhance notes"}
              </button>
            )
          )}
          <button
            type="button"
            onClick={onReviewTranscript}
            className="btn btn-secondary btn-lg flex-1"
          >
            Review transcript
          </button>
          {!ready && (
            <button
              type="button"
              onClick={onDismiss}
              className="btn btn-ghost btn-lg"
            >
              Back to notes
            </button>
          )}
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
