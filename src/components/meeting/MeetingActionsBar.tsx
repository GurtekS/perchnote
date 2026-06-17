import { Play, Pause, PanelRightOpen, PanelRightClose } from "lucide-react";
import { AudioBars } from "./AudioBars";
import { EnhanceButton } from "./EnhanceButton";

interface Props {
  isRecording: boolean;
  isPaused: boolean;
  transcriptDrawerOpen: boolean;
  onToggleTranscriptDrawer: () => void;
  // Not-recording handlers
  onStart: () => void;
  meetingId: string;
  noteContent?: string;
  isEnhanced: boolean;
  onEnhanced: (enhancedJson: string, rawMarkdown: string) => void;
  onUndoEnhance: () => void;
  onEnhancingChange: (enhancing: boolean) => void;
  enhanceTriggerRef: React.MutableRefObject<(() => void) | null>;
  // Recording handlers
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function MeetingActionsBar(props: Props) {
  const { isRecording, isPaused, transcriptDrawerOpen, onToggleTranscriptDrawer } = props;
  const barStyle = {
    background: "var(--toolbar-bg)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    borderTop: "1px solid var(--toolbar-border)",
  } as const;

  if (isRecording) {
    return (
      <div className="flex min-h-12 shrink-0 items-center px-3 py-2 sm:px-4" style={barStyle} role="toolbar" aria-label="Recording controls">
        <button
          type="button"
          onClick={onToggleTranscriptDrawer}
          className={`icon-btn ${transcriptDrawerOpen ? "text-accent bg-accent/10 border-accent/30" : ""}`}
          title={transcriptDrawerOpen ? "Close transcript (⌘T)" : "Open transcript (⌘T)"}
          aria-label={transcriptDrawerOpen ? "Close transcript" : "Open transcript"}
          aria-pressed={transcriptDrawerOpen}
        >
          {transcriptDrawerOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
        <div className="ml-3 opacity-50"><AudioBars isRecording={isRecording} /></div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={isPaused ? props.onResume : props.onPause}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
            style={{ background: "rgba(var(--accent-rgb),0.12)", color: "var(--color-recording)" }}
            title={isPaused ? "Resume recording" : "Pause recording"}
            aria-label={isPaused ? "Resume recording" : "Pause recording"}
          >
            {isPaused ? <Play size={12} /> : <Pause size={12} />}
          </button>
          <button
            type="button"
            onClick={props.onStop}
            className={`flex h-8 min-w-[96px] items-center justify-center gap-1.5 rounded-full px-4 text-body-sm font-semibold text-white transition-all ${!isPaused ? "bg-recording recording-pulse" : "bg-recording/50"}`}
            title="Stop recording"
            aria-label="Stop recording"
          >
            <div className="w-2.5 h-2.5 bg-white rounded-sm shrink-0" />
            <span>{isPaused ? "Paused" : "Stop"}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-12 shrink-0 items-center gap-2 px-3 py-2 sm:px-4" style={barStyle} role="toolbar" aria-label="Meeting actions">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleTranscriptDrawer}
          className={`icon-btn ${transcriptDrawerOpen ? "text-accent bg-accent/10 border-accent/30" : ""}`}
          title={transcriptDrawerOpen ? "Close transcript (⌘T)" : "Open transcript (⌘T)"}
          aria-label={transcriptDrawerOpen ? "Close transcript" : "Open transcript"}
          aria-pressed={transcriptDrawerOpen}
        >
          {transcriptDrawerOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
        <EnhanceButton
          meetingId={props.meetingId}
          currentContent={props.noteContent || undefined}
          onEnhanced={props.onEnhanced}
          isEnhanced={props.isEnhanced}
          onUndoEnhance={props.onUndoEnhance}
          variant="ghost"
          onEnhancingChange={props.onEnhancingChange}
          triggerRef={props.enhanceTriggerRef}
        />
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={props.onStart}
          className="flex h-8 min-w-[112px] items-center justify-center gap-1.5 rounded-full px-4 text-body-sm font-semibold transition-all hover:brightness-110"
          style={{
            background: "rgba(var(--accent-rgb), 0.1)",
            border: "1px solid rgba(var(--accent-rgb), 0.25)",
            color: "var(--color-text-primary)",
          }}
          title="Start recording"
          aria-label="Start recording"
        >
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: "var(--color-recording)" }} />
          <span>Record</span>
        </button>
      </div>
    </div>
  );
}
