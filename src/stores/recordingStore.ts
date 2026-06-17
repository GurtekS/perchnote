import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import { isTauriRuntime } from "../lib/runtime";

interface TranscriptSegment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
}

export interface CaptureHealth {
  mic: "ok" | "stalled" | "rebuilding";
  system: "ok" | "silent" | "stalled" | "rebuilding" | "permission_lost";
  mixer: "ok" | "dead";
}

interface RecordingStore {
  isRecording: boolean;
  isPaused: boolean;
  meetingId: string | null;
  /** Wall-clock ms when this session started — timers derive elapsed from
   *  it instead of counting ticks, so they can't drift or reset on remount. */
  startedAt: number | null;
  /** Live capture-degradation state (plan v7 #10); null = all healthy. */
  captureHealth: CaptureHealth | null;
  segments: TranscriptSegment[];
  transcriptionStatus: string | null;
  error: string | null;

  // Set when a recording start is blocked because system-audio capture is on
  // but Screen Recording permission is missing. Drives the permission dialog.
  systemAudioPermissionRequired: boolean;
  pendingMeetingId: string | null;

  startRecording: (
    meetingId: string,
    opts?: { systemAudio?: boolean },
  ) => Promise<void>;
  stopRecording: () => Promise<string | null>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  clearError: () => void;

  // Permission-dialog actions
  recordMicOnly: () => Promise<void>;
  dismissPermissionDialog: () => void;

  // Internal -- called by the global init
  _addSegment: (seg: TranscriptSegment) => void;
  _setTranscriptionStatus: (status: string) => void;
  _syncFromBackend: () => Promise<void>;
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  isRecording: false,
  isPaused: false,
  meetingId: null,
  startedAt: null,
  captureHealth: null,
  segments: [],
  transcriptionStatus: null,
  error: null,
  systemAudioPermissionRequired: false,
  pendingMeetingId: null,

  startRecording: async (meetingId: string, opts) => {
    try {
      set({ error: null, segments: [], transcriptionStatus: null });
      const deviceName = await ipc.getSetting("audio_device");
      await invoke("start_recording", {
        meetingId,
        deviceName: deviceName || null,
        systemAudio: opts?.systemAudio ?? null,
      });
      set({
        isRecording: true,
        meetingId,
        startedAt: Date.now(),
        captureHealth: null,
        systemAudioPermissionRequired: false,
        pendingMeetingId: null,
      });
    } catch (e) {
      const msg = String(e);
      // The backend refuses to start (rather than silently recording pure
      // silence) when system audio is on but Screen Recording isn't granted.
      // Surface the permission dialog instead of a generic error toast.
      if (msg.includes("SYSTEM_AUDIO_PERMISSION_REQUIRED")) {
        set({ systemAudioPermissionRequired: true, pendingMeetingId: meetingId });
        return;
      }
      console.error("Recording failed:", msg);
      set({ error: msg });
    }
  },

  // Start the pending recording with system audio disabled for this session
  // only (the saved "capture system audio" preference is left untouched).
  recordMicOnly: async () => {
    const meetingId = get().pendingMeetingId;
    set({ systemAudioPermissionRequired: false, pendingMeetingId: null });
    if (meetingId) {
      await get().startRecording(meetingId, { systemAudio: false });
    }
  },

  dismissPermissionDialog: () =>
    set({ systemAudioPermissionRequired: false, pendingMeetingId: null }),

  stopRecording: async () => {
    try {
      const meetingId = await invoke<string>("stop_recording");
      set({ isRecording: false, isPaused: false, meetingId: null, startedAt: null, captureHealth: null });
      return meetingId;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  pauseRecording: async () => {
    try {
      await ipc.pauseRecording();
      set({ isPaused: true });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  resumeRecording: async () => {
    try {
      await ipc.resumeRecording();
      set({ isPaused: false });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  clearError: () => set({ error: null }),

  _addSegment: (seg) =>
    set((state) => ({ segments: [...state.segments, seg] })),

  _setTranscriptionStatus: (status) =>
    set({ transcriptionStatus: status }),

  _syncFromBackend: async () => {
    try {
      const [recording, paused, meetingId] = await Promise.all([
        invoke<boolean>("is_recording"),
        ipc.isPaused(),
        ipc.getRecordingMeetingId(),
      ]);
      if (recording && !get().isRecording) {
        // Resuming UI state over an already-running backend session: the
        // true start time isn't known here, so timers fall back to their
        // own baseline (startedAt stays null).
        set({ isRecording: true, isPaused: paused, meetingId: meetingId ?? null });
      }
    } catch {
      // Backend not ready yet
    }
  },
}));

// Global event listeners -- initialized once at app startup
let initialized = false;
const unlisteners: UnlistenFn[] = [];

export async function initRecordingListeners() {
  if (initialized) return;
  initialized = true;

  if (!isTauriRuntime()) return;

  const store = useRecordingStore;

  // Sync initial state from backend
  await store.getState()._syncFromBackend();

  const u1 = await listen<TranscriptSegment>("transcript-segment", (event) => {
    if (!isValidSegment(event.payload)) return;
    store.getState()._addSegment(event.payload);
  });
  unlisteners.push(u1);

  const u2 = await listen<string>("transcription-status", (event) => {
    if (typeof event.payload !== "string" || event.payload.length > 256) return;
    store.getState()._setTranscriptionStatus(event.payload);
  });
  unlisteners.push(u2);

  // Capture-health transitions (both directions) — drives the persistent
  // degradation banner in MeetingView. All-ok clears back to null.
  const u3 = await listen<CaptureHealth>("capture-health", (event) => {
    const h = event.payload;
    if (!h || typeof h !== "object") return;
    const healthy = h.mic === "ok" && h.system === "ok" && h.mixer === "ok";
    useRecordingStore.setState({ captureHealth: healthy ? null : h });
  });
  unlisteners.push(u3);
}

function isValidSegment(p: unknown): p is TranscriptSegment {
  if (!p || typeof p !== "object") return false;
  const seg = p as Record<string, unknown>;
  return (
    typeof seg.text === "string" &&
    seg.text.length < 10_000 &&
    typeof seg.start_ms === "number" &&
    Number.isFinite(seg.start_ms) &&
    typeof seg.end_ms === "number" &&
    Number.isFinite(seg.end_ms) &&
    (seg.speaker === null || typeof seg.speaker === "string")
  );
}
