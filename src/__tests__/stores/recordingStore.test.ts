import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock Tauri modules BEFORE importing the store
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
// Mock the ipc lib so getSetting is fully controlled
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getSetting: vi.fn().mockResolvedValue(null),
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { ipc } from "../../lib/ipc";
import { useRecordingStore } from "../../stores/recordingStore";

const mockInvoke = vi.mocked(invoke);
const mockGetSetting = vi.mocked(ipc.getSetting);

describe("recordingStore", () => {
  beforeEach(() => {
    useRecordingStore.setState({
      isRecording: false,
      meetingId: null,
      segments: [],
      transcriptionStatus: null,
      error: null,
    });
    vi.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
  });

  it("initial state is correct", () => {
    const state = useRecordingStore.getState();
    expect(state.isRecording).toBe(false);
    expect(state.meetingId).toBeNull();
    expect(state.segments).toHaveLength(0);
    expect(state.transcriptionStatus).toBeNull();
    expect(state.error).toBeNull();
  });

  it("startRecording invokes start_recording and sets isRecording", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // start_recording succeeds
    await useRecordingStore.getState().startRecording("meeting-abc");
    expect(mockInvoke).toHaveBeenCalledWith("start_recording", expect.objectContaining({ meetingId: "meeting-abc" }));
    expect(useRecordingStore.getState().isRecording).toBe(true);
    expect(useRecordingStore.getState().meetingId).toBe("meeting-abc");
  });

  it("startRecording clears error and segments before starting", async () => {
    useRecordingStore.setState({ error: "old error", segments: [{ text: "old", start_ms: 0, end_ms: 1, speaker: null }] });
    mockInvoke.mockResolvedValueOnce(undefined);
    await useRecordingStore.getState().startRecording("mtg-1");
    expect(useRecordingStore.getState().error).toBeNull();
    expect(useRecordingStore.getState().segments).toHaveLength(0);
  });

  it("startRecording sets error on invoke failure", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("microphone unavailable"));
    await useRecordingStore.getState().startRecording("mtg-1");
    expect(useRecordingStore.getState().isRecording).toBe(false);
    expect(useRecordingStore.getState().error).toContain("microphone unavailable");
  });

  it("stopRecording invokes stop_recording and clears recording state", async () => {
    useRecordingStore.setState({ isRecording: true, meetingId: "mtg-1" });
    mockInvoke.mockResolvedValueOnce("mtg-1"); // stop_recording returns meetingId
    const result = await useRecordingStore.getState().stopRecording();
    expect(result).toBe("mtg-1");
    expect(useRecordingStore.getState().isRecording).toBe(false);
    expect(useRecordingStore.getState().meetingId).toBeNull();
  });

  it("stopRecording sets error on failure and returns null", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("not recording"));
    const result = await useRecordingStore.getState().stopRecording();
    expect(result).toBeNull();
    expect(useRecordingStore.getState().error).toContain("not recording");
  });

  it("_addSegment appends to segments array", () => {
    const seg = { text: "Hello", start_ms: 0, end_ms: 1000, speaker: "A" };
    useRecordingStore.getState()._addSegment(seg);
    expect(useRecordingStore.getState().segments).toHaveLength(1);
    expect(useRecordingStore.getState().segments[0].text).toBe("Hello");
  });

  it("_addSegment preserves existing segments", () => {
    useRecordingStore.getState()._addSegment({ text: "First", start_ms: 0, end_ms: 500, speaker: null });
    useRecordingStore.getState()._addSegment({ text: "Second", start_ms: 500, end_ms: 1000, speaker: null });
    expect(useRecordingStore.getState().segments).toHaveLength(2);
  });

  it("_setTranscriptionStatus updates status", () => {
    useRecordingStore.getState()._setTranscriptionStatus("transcribing");
    expect(useRecordingStore.getState().transcriptionStatus).toBe("transcribing");
    useRecordingStore.getState()._setTranscriptionStatus("complete");
    expect(useRecordingStore.getState().transcriptionStatus).toBe("complete");
  });

  it("clearError resets error to null", () => {
    useRecordingStore.setState({ error: "some error" });
    useRecordingStore.getState().clearError();
    expect(useRecordingStore.getState().error).toBeNull();
  });
});
