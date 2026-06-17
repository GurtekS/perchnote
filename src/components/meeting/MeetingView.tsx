import { useState, useCallback, useReducer, useRef, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, FileQuestion, Mic, Loader2, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../../lib/ipc";
import { toUserMessage } from "../../lib/errors";
import { scheduleMirror } from "../../lib/mirrorLifecycle";
import { useOverlay } from "../../lib/overlayStack";
import { setRecordingElapsedMs } from "../../lib/recordingClock";
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
import { RecordingAssist } from "./RecordingAssist";
import { MetadataStrip } from "./MetadataStrip";
import {
  createInitialEnhancementState,
  enhancementReducer,
  type EnhancementAction,
  isEnhanced as selectIsEnhanced,
  isEnhancing as selectIsEnhancing,
  isAnimating as selectIsAnimating,
  animationText as selectAnimationText,
  pendingEnhancedJson as selectPendingEnhancedJson,
  streamPreview as selectStreamPreview,
  saveTarget as selectSaveTarget,
} from "./enhancementMachine";

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
    captureHealth,
    transcriptionStatus,
  } = useRecordingStore();

  // Audio device state for the recording strip
  const [activeDevice, setActiveDevice] = useState<string>("");
  const [isSwitchingDevice, setIsSwitchingDevice] = useState(false);
  const wasRecordingThisMeeting = useRef(false);

  const { data: availableDevices = [] } = useQuery({
    queryKey: ["audioDevices"],
    queryFn: () => invoke<string[]>("list_audio_devices"),
    enabled: isRecording,
  });

  // Gates the live "Catch me up" button (plan v9 #5) — without a provider
  // the affordance shouldn't exist at all. Not gated on isRecording: the
  // post-recording screen reads it after stop to decide whether instant
  // recap is even possible.
  const { data: aiConfigured = false } = useQuery({
    queryKey: ["aiConfigured"],
    queryFn: ipc.checkAiConfigured,
    staleTime: 60_000,
  });

  // Whether instant recap will run on stop (default ON). Combined with
  // aiConfigured + a non-empty transcript, this tells the post-recording
  // screen that notes are coming automatically — so it should wait on them
  // rather than offer a manual Enhance that duplicates the work.
  const { data: autoEnhanceSetting = "" } = useQuery({
    queryKey: ["setting", "auto_enhance_on_complete"],
    queryFn: () => ipc.getSetting("auto_enhance_on_complete").then((v) => v ?? ""),
    staleTime: 60_000,
  });
  const autoEnhanceEnabled = autoEnhanceSetting !== "false";
  // The background instant-recap run lives outside this meeting's enhance
  // machine (it fires from __root), so isEnhancing never sees it.
  const autoEnhanceInFlight = useUIStore((s) => s.autoEnhancingMeetingId) === meetingId;

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
      try {
        await ipc.setSetting("audio_device", newDevice || "");
        setActiveDevice(newDevice);
        // Stop+start on the same meeting: the backend appends to the
        // existing WAV, keeps the original start time, offsets new
        // transcript segments to the audio's real end, and merges talk
        // stats — the switch no longer truncates anything.
        await stopRecording();
        await startRecording(meetingId);
        toast.success(`Switched to ${newDevice || "default mic"}`);
      } catch (e) {
        toast.error(toUserMessage(e), "Couldn't switch the mic");
      } finally {
        setIsSwitchingDevice(false);
      }
    },
    [activeDevice, isSwitchingDevice, meetingId, stopRecording, startRecording]
  );

  // UI state
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "idle">("idle");
  const saveStatusRef = useRef(saveStatus);
  saveStatusRef.current = saveStatus;
  const [isTagEditing, setIsTagEditing] = useState(false);
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false);
  // Esc closes the drawer when it's the topmost layer (palette/dialogs
  // stack above it on the ladder and close first).
  useOverlay(transcriptDrawerOpen, () => setTranscriptDrawerOpen(false));
  const [viewMode, setViewMode] = useState<"notes" | "transcript">("notes");
  // Enhancement pipeline — ONE explicit state machine (enhancementMachine.ts)
  // instead of the old pile of interlocking booleans. Every transition (start,
  // stream-delta, resolve, animation-complete, undo, display-mode,
  // meeting-switch reset) goes through the reducer; the view reads derived
  // selectors only.
  const [machineState, dispatchEnhancement] = useReducer(
    enhancementReducer,
    meetingId,
    createInitialEnhancementState,
  );
  // Render against a fresh machine the instant the meeting changes — the
  // reset effect below re-keys the stored state, but effects run after paint,
  // and that one stale frame is exactly where the previous meeting's
  // enhancement state could leak into this one.
  const machine =
    machineState.meetingId === meetingId
      ? machineState
      : createInitialEnhancementState(meetingId);
  // Every action is tagged with the meeting it's dispatched for — the reducer
  // drops stale actions from a meeting no longer on screen (the route
  // component is REUSED across ids; this state machine already shipped one
  // cross-meeting note-leak bug).
  const send = useCallback(
    (action: EnhancementAction) => dispatchEnhancement({ ...action, meetingId }),
    [meetingId],
  );
  const isEnhanced = selectIsEnhanced(machine);
  const isEnhancing = selectIsEnhancing(machine);
  const isAnimating = selectIsAnimating(machine);
  const notesDisplayMode = machine.displayMode;
  const streamPreview = selectStreamPreview(machine);
  const enhanceAnimText = selectAnimationText(machine);
  const preEnhanceContent = machine.preEnhanceContent;
  const enhancedContent = machine.enhancedContent;
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

  // Elapsed timer for recording header — also feeds the module-level
  // recording clock so the editor's block-time anchors (a TipTap plugin
  // outside this React tree) can stamp blocks as they're typed.
  useEffect(() => {
    if (!isRecording || !meeting?.actual_start) {
      setElapsedSeconds(0);
      setRecordingElapsedMs(null);
      return;
    }
    const tick = () => {
      const ms = Date.now() - new Date(meeting.actual_start!).getTime();
      setElapsedSeconds(Math.floor(ms / 1000));
      setRecordingElapsedMs(ms);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
      setRecordingElapsedMs(null);
    };
  }, [isRecording, meeting?.actual_start]);

  // Consume pendingAutoStart per meeting — the route component is REUSED
  // across $id changes (no remount), so mount-only consumption dropped the
  // flag on meeting→meeting navigation and fired it later on the wrong
  // meeting (friction audit #3: palette "Start Recording" was broken).
  const pendingAutoStartId = useUIStore((s) => s.pendingAutoStart);
  useEffect(() => {
    // Consume ONLY a flag aimed at this meeting. Subscribing to the flag
    // (not just meetingId) means a setter targeting the meeting already on
    // screen fires immediately instead of dangling armed — the dangling
    // flag was a phantom recording waiting for any later navigation.
    if (pendingAutoStartId === meetingId) {
      setPendingAutoStart(null);
      const t = setTimeout(() => handleStart(), 100);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, pendingAutoStartId]);

  // Live enhance stream (plan rank 1): accumulate summary words the backend
  // emits while the model writes, shown in place of the skeleton. The text
  // lives in the machine's enhancing phase (gone the moment the run settles);
  // the per-meeting filter on the event payload is preserved here, and the
  // meeting tag on the action is the reducer's second line of defense.
  useEffect(() => {
    if (!isEnhancing) return;
    let unlisten: (() => void) | null = null;
    listen<{ meeting_id: string; text: string }>("enhance-delta", (e) => {
      if (e.payload.meeting_id === meetingId) {
        send({ type: "stream-delta", text: e.payload.text });
      }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [isEnhancing, meetingId, send]);

  // One-click Enhance pathing: a list-card Enhance button navigates here with
  // this flag set; trigger the same flow as the toolbar button once mounted.
  const setPendingAutoEnhance = useUIStore((s) => s.setPendingAutoEnhance);
  useEffect(() => {
    if (useUIStore.getState().pendingAutoEnhance) {
      setPendingAutoEnhance(false);
      const t = setTimeout(() => enhanceTriggerRef.current?.(), 400);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  // Insert a transcribed line as a timestamped quote — shared by ⌘⇧D and
  // click-to-quote in the live transcript pane.
  const insertQuotedSegment = useCallback(
    (seg: { text: string; start_ms: number }) => {
      editorRef.current
        ?.getEditor()
        ?.chain()
        .focus()
        .insertContent([
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "timestampChip", attrs: { ms: seg.start_ms } },
                  { type: "text", text: ` ${seg.text.trim()}` },
                ],
              },
            ],
          },
          { type: "paragraph" },
        ])
        .run();
    },
    [],
  );

  // ⌘D while recording: stamp the current elapsed time at the cursor so a
  // moment can be marked without breaking listening flow (plan rank 8 v1 —
  // the mark lands in the raw notes and travels into Enhance context), AND
  // flag the transcript segment at that moment (plan v3 rank 6) — applied
  // immediately if it exists, or when whisper delivers it seconds later.
  useEffect(() => {
    if (!isRecording) return;
    const handler = (e: KeyboardEvent) => {
      // ⌘⇧D: quote what was just said (plan v7 capture 8) — the latest
      // transcribed line lands as a timestamped quote, covering the
      // "I half-heard that, capture it verbatim" moment with zero typing.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const segs = useRecordingStore.getState().segments;
        const last = segs[segs.length - 1];
        if (last?.text?.trim()) insertQuotedSegment(last);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        // A real inline node (plan v7 capture 6) — survives edits and
        // replays on plain click; the old plain-text "⏱ m:ss" marks
        // needed a fragile regex ⌘-click handler.
        editorRef.current
          ?.getEditor()
          ?.chain()
          .focus()
          .insertContent([
            { type: "timestampChip", attrs: { ms: elapsedSeconds * 1000 } },
            { type: "text", text: " " },
          ])
          .run();
        ipc.highlightMoment(meetingId, elapsedSeconds * 1000).catch(() => {});
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isRecording, elapsedSeconds, meetingId, insertQuotedSegment]);

  // Search → jump-to-moment: a search result navigates here with a pending
  // seek; open the drawer and hand it the (buffered) seek request. Keyed on
  // meetingId, not mount — see pendingAutoStart above. Consume only entries
  // parked for THIS meeting: a seek whose navigation never landed (deleted
  // meeting, failed route) must not replay in the next meeting opened — it
  // stays parked until its meeting consumes it or the next setPendingSeek
  // overwrites it (single-slot semantics).
  useEffect(() => {
    const pending = useUIStore.getState().pendingSeek;
    if (!pending || pending.meetingId !== meetingId) return;
    useUIStore.getState().clearPendingSeek();
    setTranscriptDrawerOpen(true);
    const ms = pending.ms;
    const t = setTimeout(() => {
      window.dispatchEvent(new CustomEvent("seek-audio", { detail: { ms } }));
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  // Source chips dispatch seek-audio; make sure the drawer (which owns the
  // audio element and performs the seek) is open to receive it.
  useEffect(() => {
    const handler = () => setTranscriptDrawerOpen(true);
    window.addEventListener("seek-audio", handler);
    return () => window.removeEventListener("seek-audio", handler);
  }, []);

  // Listen for open-transcript-drawer DOM event (dispatched by __root.tsx Cmd+T handler)
  useEffect(() => {
    const handler = () => setTranscriptDrawerOpen((prev) => !prev);
    document.addEventListener("open-transcript-drawer", handler);
    return () => document.removeEventListener("open-transcript-drawer", handler);
  }, []);

  // Empty recording discarded (backend deleted the row because the stop
  // captured no audio and no notes): if it's the meeting on screen, leave
  // for home rather than render a deleted meeting. Keyed on meetingId so a
  // stale listener can't navigate away from an unrelated meeting.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ meeting_id: string }>("meeting-discarded", (e) => {
      if (e.payload.meeting_id !== meetingId) return;
      setReviewMode(false);
      toast.info("Empty recording discarded. No audio was captured.");
      navigate({ to: "/" });
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [meetingId, navigate]);

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
        // Honest copy (whole-app review P3): a save may still be debouncing
        // or have failed — report the actual state, not a placebo.
        if (saveStatusRef.current === "saving") toast.info("Saving…");
        else toast.info("Notes auto-save as you type");
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
    // The transcript timeline excludes paused stretches (the mixer skips
    // writes while paused) — wall-clock counted a 20-minute pause as
    // meeting time (whole-app review P3). Prefer the audio timeline.
    const lastMs = segs.length > 0 ? segs[segs.length - 1].end_ms : 0;
    const duration = lastMs > 0
      ? Math.floor(lastMs / 1000)
      : meeting?.actual_start
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

  // Resolve the note row id, creating one atomically if it doesn't exist yet.
  // Centralizes row creation so AI and raw saves never race into duplicate rows
  // and AI content never gets misrouted into raw_content for a row-less meeting.
  const ensureNoteId = useCallback(async (): Promise<string | null> => {
    if (note?.id) return note.id;
    if (noteCreationInFlight.current) return null;
    noteCreationInFlight.current = true;
    try {
      const ensured = await ipc.getOrCreateNote(meetingId);
      queryClient.invalidateQueries({ queryKey: ["note", meetingId] });
      return ensured.id;
    } finally {
      noteCreationInFlight.current = false;
    }
  }, [note?.id, meetingId, queryClient]);

  // Auto-save for the MAIN editor. It holds the AI notes whenever the meeting
  // is enhanced (AI or Split view) and the user's own notes otherwise — the
  // save target comes from the machine's saveTarget selector, never from
  // scattered booleans. The "My Notes" editor saves via handleOriginalUpdate,
  // so this never needs the display mode.
  const saveTarget = selectSaveTarget(machine);
  const handleNoteUpdate = useCallback(
    async (json: string) => {
      setSaveStatus("saving");
      try {
        const id = await ensureNoteId();
        if (!id) {
          setSaveStatus("idle");
          return;
        }
        if (saveTarget === "generated_content") {
          // Enhanced → this editor is the AI surface; persist to generated_content.
          await ipc.updateNoteGeneratedContent(id, json);
        } else {
          await ipc.updateNoteRawContent(id, json);
        }
        // Mirror follows the note (plan v8 B2): refresh the vault .md once
        // the edits settle. Fire-and-forget — never in the save's way.
        scheduleMirror(meetingId);
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch {
        toast.error("Failed to save notes");
        setSaveStatus("idle");
      }
    },
    [ensureNoteId, saveTarget, meetingId]
  );

  // Commit the meeting-switch reset (the derived `machine` above already
  // renders fresh for the new meeting before this lands). Declared before the
  // restore effect below so the reset is processed first.
  useEffect(() => {
    wasRecordingThisMeeting.current = false;
    noteCreationInFlight.current = false;
    send({ type: "reset" });
  }, [meetingId, send]);

  // On mount/note-change: detect generated_content and restore enhanced state.
  // The mode switch and imperative editor seed happen once per meeting
  // (machine.hasRestored), but note-loaded fires on every refetch — external
  // writers (the tasks view toggling an action item) update the note and
  // invalidate this query, and their changes would otherwise be lost to the
  // first cached snapshot.
  useEffect(() => {
    if (!note?.generated_content || isAnimating) return;
    if (!machine.hasRestored && editorRef.current) {
      editorRef.current.setContent(note.generated_content);
    }
    send({ type: "note-loaded", generated: note.generated_content, raw: note.raw_content || undefined });
  }, [note?.generated_content, note?.raw_content, isAnimating, machine.hasRestored, send]);

  // Enhancement handlers. EnhanceButton only calls this after its startedFor
  // guard confirmed the run resolved for the meeting still on screen.
  const handleEnhanced = useCallback(
    (enhancedJson: string, rawMarkdown: string) => {
      // resolve → animating: keeps the original for undo, records the AI
      // body, and arms the typewriter overlay (editor content is injected on
      // animation-complete).
      send({
        type: "resolve",
        enhancedJson,
        rawMarkdown,
        rawContent: note?.raw_content || undefined,
      });
    },
    [note?.raw_content, send]
  );

  // Auto-save for the "My Notes" editor — always persists to raw_content,
  // creating the note row first if needed so original notes are never dropped.
  const handleOriginalUpdate = useCallback(
    async (json: string) => {
      send({ type: "original-saved", json });
      try {
        const id = await ensureNoteId();
        if (id) {
          await ipc.updateNoteRawContent(id, json);
          scheduleMirror(meetingId);
        }
      } catch {
        // non-fatal
      }
    },
    [ensureNoteId, meetingId, send]
  );

  const handleUndoEnhance = useCallback(() => {
    send({ type: "undo" });
    const original = preEnhanceContent ?? note?.raw_content;
    if (editorRef.current) {
      editorRef.current.setContent(
        original || '{"type":"doc","content":[{"type":"paragraph"}]}'
      );
    }
    toast.info("Enhancement reverted");
  }, [preEnhanceContent, note?.raw_content, send]);

  // Re-inject enhanced content when switching back to AI Notes tab, or when the
  // editor remounts after the isEnhancing skeleton is dismissed (!isEnhancing)
  useEffect(() => {
    if (
      !isEnhancing &&
      (notesDisplayMode === "ai" || notesDisplayMode === "split") &&
      isEnhanced &&
      enhancedContent &&
      editorRef.current
    ) {
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
          <div className="flex items-center gap-2 ml-4 shrink-0">
            <button
              onClick={() => { clearError(); handleStart(); }}
              className="px-2 py-0.5 rounded border border-red-400/40 text-xs text-red-300 hover:bg-red-500/15"
            >
              Retry
            </button>
            <button
              onClick={clearError}
              aria-label="Dismiss error"
              className="text-red-400/60 hover:text-red-400"
            >
              &times;
            </button>
          </div>
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

      {/* Tags bar — hidden while recording: nothing competes with capture
          (plan v7 quiet mode). */}
      {!isRecording && (
        <div className={`px-6 py-2 shrink-0 ${meetingTags.length > 0 || isTagEditing ? "border-b border-border" : ""}`}>
          <TagEditor meetingId={meetingId} onEditingChange={setIsTagEditing} />
        </div>
      )}

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
              <span className="flex items-center gap-1.5 text-caption text-text-muted">
                <Loader2 size={11} className="animate-spin shrink-0" />
                Switching mic…
              </span>
            ) : (
              <>
                <Mic size={11} className="text-text-muted shrink-0" />
                <select
                  value={activeDevice}
                  onChange={(e) => handleSwitchDevice(e.target.value)}
                  className="max-w-[220px] truncate bg-transparent text-caption text-text-secondary focus:outline-none cursor-pointer sm:max-w-[160px]"
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

      {/* Capture health — PERSISTENT while degraded (a transient toast dies
          unseen under a fullscreen call); clears itself on recovery. */}
      {isRecording && captureHealth && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 sm:px-6"
        >
          <AlertCircle size={12} className="shrink-0 text-amber-500" />
          <span className="text-xs font-medium text-amber-500">
            {captureHealth.mixer === "dead"
              ? "Audio capture stopped. Stop and restart the recording. Audio up to now is saved."
              : [
                  captureHealth.mic === "stalled"
                    ? "Mic silent: check the input device"
                    : captureHealth.mic === "rebuilding"
                    ? "Mic silent, reconnecting…"
                    : null,
                  captureHealth.system === "permission_lost"
                    ? "Screen Recording revoked. Participants' audio is no longer captured."
                    : captureHealth.system === "silent"
                    ? "No system audio for a while. If the call isn't just quiet, participants may not be captured."
                    : captureHealth.system === "stalled"
                    ? "System audio stopped, attempting recovery"
                    : captureHealth.system === "rebuilding"
                    ? "Rebuilding system audio capture…"
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        </div>
      )}

      {/* Transcription health (whole-app review P1): the backend emits
          "model not found" / "transcription stopped" the moment they
          happen — this used to be stored and rendered NOWHERE, so users
          recorded hour-long meetings against a dead transcriber and found
          out at "0 transcript segments". Same persistent posture as
          captureHealth: audio still records either way. */}
      {isRecording && transcriptionStatus && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-recording/30 bg-recording/10 px-4 py-1.5 sm:px-6"
        >
          <AlertCircle size={12} className="shrink-0 text-recording" />
          <span className="text-xs font-medium text-recording">
            {transcriptionStatus}. Audio is still being recorded and can be
            transcribed later from Settings → Audio.
          </span>
        </div>
      )}

      {/* Main content area — PostRecordingScreen or notepad */}
      {reviewMode && reviewData ? (
        <PostRecordingScreen
          meetingId={meetingId}
          duration={reviewData.duration}
          segmentCount={reviewData.segmentCount}
          speakerCount={reviewData.speakerCount}
          autoEnhanceExpected={
            autoEnhanceEnabled && aiConfigured && reviewData.segmentCount > 0
          }
          isEnhancing={isEnhancing || autoEnhanceInFlight}
          isEnhanced={isEnhanced || !!note?.generated_content}
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
        {/* Notepad and live transcript — BOTH stay mounted while recording;
            visibility (not unmount) flips between them, so the editor keeps
            its caret/undo state and each pane keeps its scroll position
            (plan v7 capture 5: the flip used to lose all of it mid-call). */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {isRecording && (
            <div
              className={`absolute inset-0 ${
                viewMode === "transcript" ? "" : "invisible pointer-events-none"
              }`}
            >
              <LiveTranscriptView
                segments={liveSegments}
                onQuote={insertQuotedSegment}
              />
            </div>
          )}
          {/* Catch-me-up + Ask AI pills overlay the pane CONTAINER, not the
              transcript pane, so they're visible in the default Notes view
              too — the late joiner who stays on Notes never saw them
              (deep review P2). */}
          {isRecording && (
            <RecordingAssist
              segmentCount={liveSegments.length}
              catchMeUp={aiConfigured ? () => ipc.catchMeUp(meetingId) : undefined}
            />
          )}
          <div
            className={`absolute inset-0 overflow-y-auto ${
              isRecording && viewMode === "transcript" ? "invisible pointer-events-none" : ""
            }`}
          >
            <div className="mx-auto w-full max-w-[860px] px-4 py-5 sm:px-6">
              {/* Meeting metadata — quiet mode hides it during capture */}
              {meeting && !isRecording && (
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
                isRecording={isRecording}
                editorRef={editorRef}
                noteLoading={noteLoading}
                note={note}
                noteRawContent={note?.raw_content || undefined}
                streamPreview={streamPreview}
                preEnhanceContent={preEnhanceContent}
                enhancedContent={enhancedContent}
                isEnhanced={isEnhanced}
                notesDisplayMode={notesDisplayMode}
                onNotesDisplayModeChange={(mode) => send({ type: "display-mode", mode })}
                isEnhancing={isEnhancing}
                isAnimating={isAnimating}
                enhanceAnimText={enhanceAnimText}
                onUpdate={handleNoteUpdate}
                onOriginalUpdate={handleOriginalUpdate}
                aiTags={aiTags}
                onAnimationComplete={() => {
                  const pending = selectPendingEnhancedJson(machine);
                  send({ type: "animation-complete" });
                  if (pending && editorRef.current) {
                    editorRef.current.setContent(pending);
                  }
                  queryClient.invalidateQueries({ queryKey: ["note", meetingId] });
                }}
              />
            </div>
          </div>
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
        onEnhancingChange={(enhancing) =>
          // `start` latches machine.hasRestored: the run invalidates the note
          // query mid-flight and that refetch must not re-trigger the
          // restore path.
          send(enhancing ? { type: "start" } : { type: "enhance-finished" })
        }
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
                className="btn btn-secondary"
              >
                <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
                Retry
              </button>
            )}
            {onReturn && (
              <button
                type="button"
                onClick={onReturn}
                className="btn btn-primary"
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
