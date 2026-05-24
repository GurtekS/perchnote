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

interface RecordingStore {
  isRecording: boolean;
  isPaused: boolean;
  meetingId: string | null;
  segments: TranscriptSegment[];
  transcriptionStatus: string | null;
  error: string | null;

  startRecording: (meetingId: string) => Promise<void>;
  stopRecording: () => Promise<string | null>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  clearError: () => void;

  // Internal -- called by the global init
  _addSegment: (seg: TranscriptSegment) => void;
  _setTranscriptionStatus: (status: string) => void;
  _syncFromBackend: () => Promise<void>;
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  isRecording: false,
  isPaused: false,
  meetingId: null,
  segments: [],
  transcriptionStatus: null,
  error: null,

  startRecording: async (meetingId: string) => {
    try {
      set({ error: null, segments: [], transcriptionStatus: null });
      const deviceName = await ipc.getSetting("audio_device");
      await invoke("start_recording", {
        meetingId,
        deviceName: deviceName || null,
      });
      set({ isRecording: true, meetingId });
    } catch (e) {
      const msg = String(e);
      console.error("Recording failed:", msg);
      set({ error: msg });
    }
  },

  stopRecording: async () => {
    try {
      const meetingId = await invoke<string>("stop_recording");
      set({ isRecording: false, isPaused: false, meetingId: null });
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
