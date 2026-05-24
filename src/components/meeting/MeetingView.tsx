import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, FileQuestion, Mic, Loader2, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../../lib/ipc";
import { NoteEditorHandle } from "./NoteEditor";
import { MeetingHeader } from "./MeetingHeader";
import { TranscriptDrawer } from "./TranscriptDrawer";
import { MeetingActionsBar } from "./MeetingActionsBar";
import { NotesSurface } from "./NotesSurface";
import { TagEditor } from "./TagEditor";
import { useRecordingStore } from "../../stores/recordingStore";
import { useUIStore } from "../../stores/uiStore";
import { PostRecordingScreen } from "./PostRecordingScreen";
import { MeetingStats } from "./MeetingStats";
import { toast } from "../../stores/toastStore";
import { LiveTranscriptView } from "./LiveTranscriptView";
import { MetadataStrip } from "./MetadataStrip";

interface MeetingViewProps {
  meetingId: string;
}

export function MeetingView({ meetingId }: MeetingViewProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const editorRef = useRef<NoteEditorHandle>(null);

  // uiStore
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const focusMode = useUIStore((s) => s.focusMode);
  const pendingAutoStart = useUIStore((s) => s.pendingAutoStart);
  const setPendingAutoStart = useUIStore((s) => s.setPendingAutoStart);

  // Recording store
  const {
    isRecording,
    isPaused,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    error: recordingError,
    clearError,
    segments: liveSegments,
  } = useRecordingStore();

  // Audio device state for the recording strip
  const [activeDevice, setActiveDevice] = useState<string>("");
  const [isSwitchingDevice, setIsSwitchingDevice] = useState(false);
  const suppressEnhanceBanner = useRef(false);
  const wasRecordingThisMeeting = useRef(false);

  const { data: availableDevices = [] } = useQuery({
    queryKey: ["audioDevices"],
    queryFn: () => invoke<string[]>("list_audio_devices"),
    enabled: isRecording,
  });

  // Sync active device from settings when recording starts. The backend
  // also emits `audio-device-active` with the actual device used (which
  // may differ from the saved name if the saved device disappeared and
  // we fell back to the default) — that event listener below is the
  // source of truth.
  useEffect(() => {
    if (isRecording) {
      ipc.getSetting("audio_device").then((d) => setActiveDevice(d || ""));
    }
  }, [isRecording]);

  // Authoritative source for "what mic is recording right now". The backend
  // emits this on every successful start_recording, including the fallback
  // case where the saved device wasn't available.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<string>("audio-device-active", (event) => {
      setActiveDevice(event.payload || "");
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  const handleSwitchDevice = useCallback(
    async (newDevice: string) => {
      if (newDevice === activeDevice || isSwitchingDevice) return;
      setIsSwitchingDevice(true);
      suppressEnhanceBanner.current = true;
      try {
        await ipc.setSetting("audio_device", newDevice || "");
        setActiveDevice(newDevice);
        await stopRecording();
        await startRecording(meetingId);
        toast.success(`Switched to ${newDevice || "default mic"}`);
      } catch (e) {
        toast.error(`Failed to switch mic: ${String(e)}`);
      } finally {
        setIsSwitchingDevice(false);
        suppressEnhanceBanner.current = false;
      }
    },
    [activeDevice, isSwitchingDevice, meetingId, stopRecording, startRecording]
  );

  // UI state
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "idle">("idle");
  const [isTagEditing, setIsTagEditing] = useState(false);
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false);
  const [isEnhanced, setIsEnhanced] = useState(false);
  const [preEnhanceContent, setPreEnhanceContent] = useState<string | undefined>(undefined);
  const [viewMode, setViewMode] = useState<"notes" | "transcript">("notes");
  const [notesDisplayMode, setNotesDisplayMode] = useState<"ai" | "original">("ai");
  // Enhancement loading / animation state
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhanceAnimText, setEnhanceAnimText] = useState<string | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [pendingEnhancedJson, setPendingEnhancedJson] = useState<string | null>(null);
  const [enhancedContent, setEnhancedContent] = useState<string | undefined>(undefined);
  // Guard against concurrent note creation on new meetings
  const noteCreationInFlight = useRef(false);
  const preRecordingSidebarState = useRef(false);
  const enhanceTriggerRef = useRef<(() => void) | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewData, setReviewData] = useState<{
    segmentCount: number;
    speakerCount: number | null;
    duration: number;
  } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Data queries
  const {
    data: meeting,
    isLoading: meetingLoading,
    isError: meetingIsError,
    error: meetingError,
    isFetching: meetingFetching,
    refetch: refetchMeeting,
  } = useQuery({
    queryKey: ["meeting", meetingId],
    queryFn: () => ipc.getMeeting(meetingId),
  });

  const { data: note, isLoading: noteLoading } = useQuery({
    queryKey: ["note", meetingId],
    queryFn: () => ipc.getNoteByMeeting(meetingId),
  });

  useQuery({
    queryKey: ["transcript", meetingId],
    queryFn: () => ipc.getTranscriptByMeeting(meetingId),
  });

  const { data: meetingTags = [] } = useQuery({
    queryKey: ["meetingTags", meetingId],
    queryFn: () => ipc.getMeetingTags(meetingId),
  });

  const aiTags = useMemo(() => {
    if (!note?.generated_content) return [];
    try {
      const parsed = JSON.parse(note.generated_content);
      return Array.isArray(parsed?.attrs?.tags) ? parsed.attrs.tags as string[] : [];
    } catch { return []; }
  }, [note?.generated_content]);

  // Elapsed timer for recording header
  useEffect(() => {
    if (!isRecording || !meeting?.actual_start) {
      setElapsedSeconds(0);
      return;
    }
    const tick = () => {
      setElapsedSeconds(Math.floor((Date.now() - new Date(meeting.actual_start!).getTime()) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRecording, meeting?.actual_start]);

  // Check pendingAutoStart on mount
  useEffect(() => {
    if (pendingAutoStart) {
      setPendingAutoStart(false);
      setTimeout(() => handleStart(), 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for open-transcript-drawer DOM event (dispatched by __root.tsx Cmd+T handler)
  useEffect(() => {
    const handler = () => setTranscriptDrawerOpen((prev) => !prev);
    document.addEventListener("open-transcript-drawer", handler);
    return () => document.removeEventListener("open-transcript-drawer", handler);
  }, []);

  // Listen for palette-enhance-notes (dispatched by the CommandPalette when
  // the user picks Enhance Notes). Calls into the same trigger the bottom
  // toolbar uses.
  useEffect(() => {
    const handler = () => enhanceTriggerRef.current?.();
    document.addEventListener("palette-enhance-notes", handler);
    return () => document.removeEventListener("palette-enhance-notes", handler);
  }, []);

  // Cmd+S - save confirmation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        toast.info("Notes auto-saved");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);



  // Recording handlers
  const handleStart = useCallback(async () => {
    preRecordingSidebarState.current = sidebarCollapsed;
    setSidebarCollapsed(true);
    await startRecording(meetingId);
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
  }, [meetingId, startRecording, queryClient, sidebarCollapsed, setSidebarCollapsed]);

  const handleStop = useCallback(async () => {
    // Compute reviewData before stopping
    const segs = liveSegments;
    const segmentCount = segs.length;
    const speakerCount = segs.length > 0
      ? new Set(segs.map((s) => s.speaker).filter(Boolean)).size || null
      : null;
    const duration = meeting?.actual_start
      ? Math.floor((Date.now() - new Date(meeting.actual_start).getTime()) / 1000)
      : 0;

    const noteId = await stopRecording();
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
    queryClient.invalidateQueries({ queryKey: ["transcript", meetingId] });
    if (noteId) queryClient.invalidateQueries({ queryKey: ["note", noteId] });

    // Restore sidebar (unless focus mode is active)
    if (!focusMode) {
      setSidebarCollapsed(preRecordingSidebarState.current);
    }

    setReviewData({ segmentCount, speakerCount, duration });
    setReviewMode(true);
  }, [stopRecording, queryClient, meetingId, liveSegments, meeting?.actual_start, focusMode, setSidebarCollapsed]);

  // Note update handler with auto-save
  const handleNoteUpdate = useCallback(
    async (json: string) => {
      setSaveStatus("saving");
      try {
        if (note?.id) {
          if (isEnhanced && notesDisplayMode === "ai") {
            // Edits in AI mode flow to generated_content so checkbox state survives reload.
            await ipc.updateNoteGeneratedContent(note.id, json);
          } else {
            await ipc.updateNoteRawContent(note.id, json);
          }
        } else {
          // Guard against concurrent createNote calls from rapid debounce fires
          if (noteCreationInFlight.current) return;
          noteCreationInFlight.current = true;
          try {
            const newNote = await ipc.createNote(meetingId);
            await ipc.updateNoteRawContent(newNote.id, json);
            queryClient.invalidateQueries({ queryKey: ["note", meetingId] });
          } finally {
            noteCreationInFlight.current = false;
          }
        }
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch {
        toast.error("Failed to save notes");
        setSaveStatus("idle");
      }
    },
    [note?.id, meetingId, queryClient, isEnhanced, notesDisplayMode]
  );

  // Reset all enhancement state when navigating to a different meeting
  useEffect(() => {
    hasRestoredEnhance.current = false;
    wasRecordingThisMeeting.current = false;
    noteCreationInFlight.current = false;
    setIsEnhanced(false);
    setEnhancedContent(undefined);
    setPreEnhanceContent(undefined);
    setIsEnhancing(false);
    setIsAnimating(false);
    setEnhanceAnimText(null);
    setPendingEnhancedJson(null);
    setNotesDisplayMode("ai");
  }, [meetingId]);

  // On mount/note-change: detect generated_content and restore enhanced state
  const hasRestoredEnhance = useRef(false);
  useEffect(() => {
    if (note?.generated_content && !hasRestoredEnhance.current && !isAnimating) {
      hasRestoredEnhance.current = true;
      setIsEnhanced(true);
      setNotesDisplayMode("ai");
      setPreEnhanceContent(note.raw_content || undefined);
      setEnhancedContent(note.generated_content);
      if (editorRef.current) {
        editorRef.current.setContent(note.generated_content);
      }
    }
  }, [note?.generated_content, isAnimating]);

  // Enhancement handlers
  const handleEnhanced = useCallback(
    (enhancedJson: string, rawMarkdown: string) => {
      // Keep original in state for undo
      setPreEnhanceContent(note?.raw_content || undefined);
      setIsEnhanced(true);
      setNotesDisplayMode("ai");
        setEnhancedContent(enhancedJson);
      // Start animation — editor content set in onComplete
      setEnhanceAnimText(rawMarkdown);
      setPendingEnhancedJson(enhancedJson);
      setIsAnimating(true);
    },
    [note?.raw_content]
  );

  const handleOriginalUpdate = useCallback(
    async (json: string) => {
      setPreEnhanceContent(json);
      // Persist original notes edits to raw_content
      try {
        if (note?.id) {
          await ipc.updateNoteRawContent(note.id, json);
        }
      } catch {
        // non-fatal
      }
    },
    [note?.id]
  );

  const handleUndoEnhance = useCallback(() => {
    setIsEnhanced(false);
    setNotesDisplayMode("ai");
    setEnhancedContent(undefined);
    const original = preEnhanceContent ?? note?.raw_content;
    if (editorRef.current) {
      editorRef.current.setContent(
        original || '{"type":"doc","content":[{"type":"paragraph"}]}'
      );
    }
    toast.info("Enhancement reverted");
  }, [preEnhanceContent, note?.raw_content]);

  // Re-inject enhanced content when switching back to AI Notes tab, or when the
  // editor remounts after the isEnhancing skeleton is dismissed (!isEnhancing)
  useEffect(() => {
    if (!isEnhancing && notesDisplayMode === "ai" && isEnhanced && enhancedContent && editorRef.current) {
      editorRef.current.setContent(enhancedContent);
    }
  }, [isEnhancing, notesDisplayMode, isEnhanced, enhancedContent]);

  if (meetingLoading) {
    return <MeetingFallbackState variant="loading" />;
  }

  if (meetingIsError) {
    return (
      <MeetingFallbackState
        variant="error"
        detail={meetingError instanceof Error ? meetingError.message : undefined}
        busy={meetingFetching}
        onRetry={() => refetchMeeting()}
        onReturn={() => navigate({ to: "/" })}
      />
    );
  }

  if (!meeting) {
    return (
      <MeetingFallbackState
        variant="not-found"
        busy={meetingFetching}
        onRetry={() => refetchMeeting()}
        onReturn={() => navigate({ to: "/" })}
      />
    );
  }

  return (
    <div className="h-full flex flex-col relative animate-fade-in">
      {/* Recording error banner */}
      {recordingError && (
        <div role="alert" className="px-6 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm flex items-center justify-between shrink-0">
          <span>{recordingError}</span>
          <button
            onClick={clearError}
            className="text-red-400/60 hover:text-red-400 ml-4"
          >
            &times;
          </button>
        </div>
      )}

      {/* Header */}
      <MeetingHeader
        meeting={meeting}
        meetingId={meetingId}
        saveStatus={saveStatus}
        isRecording={isRecording}
        elapsedSeconds={elapsedSeconds}
      />

      {/* Tags bar */}
      <div className={`px-6 py-2 shrink-0 ${meetingTags.length > 0 || isTagEditing ? "border-b border-border" : ""}`}>
        <TagEditor meetingId={meetingId} onEditingChange={setIsTagEditing} />
      </div>

      {/* View mode toggle + device picker — only visible while recording */}
      {isRecording && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2 sm:flex-row sm:items-center sm:px-6">
          <div
            className="view-toggle-pill"
            role="group"
            aria-label="Recording workspace view"
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setViewMode(viewMode === "notes" ? "transcript" : "notes");
              }
            }}
          >
            <button
              type="button"
              onClick={() => setViewMode("notes")}
              className={viewMode === "notes" ? "active" : ""}
              aria-pressed={viewMode === "notes"}
            >
              Notes
            </button>
            <button
              type="button"
              onClick={() => setViewMode("transcript")}
              className={viewMode === "transcript" ? "active" : ""}
              aria-pressed={viewMode === "transcript"}
            >
              Live Transcript
            </button>
          </div>
          {viewMode === "transcript" && liveSegments.length === 0 && (
            <span className="text-xs text-text-muted">Transcript will appear as you speak...</span>
          )}

          {/* Mic device selector */}
          <div className="flex min-w-0 items-center gap-1.5 sm:ml-auto">
            {isSwitchingDevice ? (
              <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <Loader2 size={11} className="animate-spin shrink-0" />
                Switching mic…
              </span>
            ) : (
              <>
                <Mic size={11} className="text-text-muted shrink-0" />
                <select
                  value={activeDevice}
                  onChange={(e) => handleSwitchDevice(e.target.value)}
                  className="max-w-[220px] truncate bg-transparent text-[11px] text-text-secondary focus:outline-none cursor-pointer sm:max-w-[160px]"
                  title="Switch microphone"
                  aria-label="Switch microphone"
                >
                  <option value="">Default mic</option>
                  {availableDevices.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
      )}

      {/* Main content area — PostRecordingScreen or notepad */}
      {reviewMode && reviewData ? (
        <PostRecordingScreen
          meetingId={meetingId}
          duration={reviewData.duration}
          segmentCount={reviewData.segmentCount}
          speakerCount={reviewData.speakerCount}
          onEnhance={() => {
            setReviewMode(false);
            setTimeout(() => enhanceTriggerRef.current?.(), 50);
          }}
          onReviewTranscript={() => {
            setTranscriptDrawerOpen(true);
            setReviewMode(false);
          }}
          onDismiss={() => setReviewMode(false)}
        />
      ) : (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Notepad or live transcript */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {isRecording && viewMode === "transcript" ? (
            <LiveTranscriptView segments={liveSegments} />
          ) : (
            <div className="mx-auto w-full max-w-[860px] px-4 py-5 sm:px-6">
              {/* Meeting metadata */}
              {meeting && (
                <MetadataStrip
                  meeting={meeting}
                  onSaved={() => queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] })}
                />
              )}

              {/* Meeting stats — shown after a recorded meeting */}
              {meeting && !isRecording && (
                <MeetingStats
                  meetingId={meetingId}
                  actualStart={meeting.actual_start}
                  actualEnd={meeting.actual_end}
                  scheduledStart={meeting.scheduled_start}
                  scheduledEnd={meeting.scheduled_end}
                />
              )}

              <NotesSurface
                meetingId={meetingId}
                editorRef={editorRef}
                noteLoading={noteLoading}
                noteRawContent={note?.raw_content || undefined}
                preEnhanceContent={preEnhanceContent}
                isEnhanced={isEnhanced}
                notesDisplayMode={notesDisplayMode}
                onNotesDisplayModeChange={setNotesDisplayMode}
                isEnhancing={isEnhancing}
                isAnimating={isAnimating}
                enhanceAnimText={enhanceAnimText}
                onUpdate={handleNoteUpdate}
                onOriginalUpdate={handleOriginalUpdate}
                aiTags={aiTags}
                onAnimationComplete={() => {
                  setIsAnimating(false);
                  setEnhanceAnimText(null);
                  if (pendingEnhancedJson && editorRef.current) {
                    editorRef.current.setContent(pendingEnhancedJson);
                  }
                  setPendingEnhancedJson(null);
                  queryClient.invalidateQueries({ queryKey: ["note", meetingId] });
                }}
              />
            </div>
          )}
        </div>

        {/* Transcript drawer */}
        <TranscriptDrawer
          meetingId={meetingId}
          isOpen={transcriptDrawerOpen}
          onClose={() => setTranscriptDrawerOpen(false)}
          liveSegments={liveSegments}
          isRecording={isRecording}
          meetingStatus={meeting?.status}
        />
      </div>
      )}

      {/* Bottom toolbar — two layouts: recording vs not-recording */}
      <MeetingActionsBar
        isRecording={isRecording}
        isPaused={isPaused}
        transcriptDrawerOpen={transcriptDrawerOpen}
        onToggleTranscriptDrawer={() => setTranscriptDrawerOpen((prev) => !prev)}
        onStart={handleStart}
        meetingId={meetingId}
        noteContent={note?.raw_content || undefined}
        isEnhanced={isEnhanced}
        onEnhanced={handleEnhanced}
        onUndoEnhance={handleUndoEnhance}
        onEnhancingChange={(enhancing) => {
          setIsEnhancing(enhancing);
          if (enhancing) hasRestoredEnhance.current = true;
        }}
        enhanceTriggerRef={enhanceTriggerRef}
        onPause={pauseRecording}
        onResume={resumeRecording}
        onStop={handleStop}
      />

    </div>
  );
}

type MeetingFallbackVariant = "loading" | "error" | "not-found";

function MeetingFallbackState({
  variant,
  detail,
  busy = false,
  onRetry,
  onReturn,
}: {
  variant: MeetingFallbackVariant;
  detail?: string;
  busy?: boolean;
  onRetry?: () => void;
  onReturn?: () => void;
}) {
  const isLoading = variant === "loading";
  const isError = variant === "error";
  const title = isLoading
    ? "Loading meeting"
    : isError
    ? "Meeting could not be opened"
    : "Meeting not found";
  const description = isLoading
    ? "Preparing notes, transcript, and meeting details."
    : isError
    ? "Perchnote could not load this meeting. Try again or return to Today."
    : "This meeting may have been deleted or is no longer available on this device.";
  const Icon = isLoading ? Loader2 : isError ? AlertCircle : FileQuestion;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[56px] items-center border-b border-border px-4 sm:px-5">
        {onReturn ? (
          <button
            type="button"
            className="icon-btn"
            onClick={onReturn}
            aria-label="Back to Today"
            title="Back to Today"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <div className="h-7 w-7" />
        )}
      </div>
      <div
        className="empty-state flex-1"
        role={isError ? "alert" : "status"}
        aria-live={isLoading ? "polite" : "assertive"}
      >
        <div className="empty-state-icon">
          <Icon size={24} className={isLoading ? "animate-spin" : ""} />
        </div>
        <h1 className="text-base font-semibold text-text-primary">{title}</h1>
        <p className="max-w-sm text-sm leading-6 text-text-muted">{detail || description}</p>
        {!isLoading && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              >
                <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
                Retry
              </button>
            )}
            {onReturn && (
              <button
                type="button"
                onClick={onReturn}
                className="inline-flex h-9 items-center justify-center rounded-lg bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
              >
                Back to Today
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
