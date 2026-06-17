import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchDeepAction, type DeepActionWire } from "../../lib/deepActions";
import { useRecordingStore } from "../../stores/recordingStore";
import { useUIStore } from "../../stores/uiStore";

function wire(over: Partial<DeepActionWire> & Pick<DeepActionWire, "action">): DeepActionWire {
  return { meeting_id: null, title: null, transcript: false, q: null, ...over };
}

function deps() {
  return {
    navigateToMeeting: vi.fn().mockResolvedValue(undefined),
    createNewMeeting: vi.fn().mockResolvedValue(undefined),
  };
}

describe("dispatchDeepAction", () => {
  beforeEach(() => {
    useRecordingStore.setState({ isRecording: false });
    useUIStore.getState().setPendingPaletteQuery(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("record-start creates a meeting, passing the deep-link title through", async () => {
    const d = deps();
    await dispatchDeepAction(wire({ action: "record-start", title: "Design Review" }), d);
    expect(d.createNewMeeting).toHaveBeenCalledWith("Design Review");

    await dispatchDeepAction(wire({ action: "record-start" }), d);
    expect(d.createNewMeeting).toHaveBeenLastCalledWith(undefined);
  });

  it("record-start is a no-op while already recording", async () => {
    useRecordingStore.setState({ isRecording: true });
    const d = deps();
    await dispatchDeepAction(wire({ action: "record-start" }), d);
    expect(d.createNewMeeting).not.toHaveBeenCalled();
  });

  it("record-stop stops and navigates to the finished meeting", async () => {
    const stopRecording = vi.fn().mockResolvedValue("m-42");
    useRecordingStore.setState({ isRecording: true, stopRecording });
    const d = deps();
    await dispatchDeepAction(wire({ action: "record-stop" }), d);
    expect(stopRecording).toHaveBeenCalled();
    expect(d.navigateToMeeting).toHaveBeenCalledWith("m-42");
  });

  it("record-stop while idle does nothing (cold-start safety)", async () => {
    const stopRecording = vi.fn();
    useRecordingStore.setState({ isRecording: false, stopRecording });
    const d = deps();
    await dispatchDeepAction(wire({ action: "record-stop" }), d);
    expect(stopRecording).not.toHaveBeenCalled();
    expect(d.navigateToMeeting).not.toHaveBeenCalled();
  });

  it("open-meeting navigates; transcript flag pops the drawer after the handoff delay", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const onOpen = () => events.push("open-transcript-drawer");
    document.addEventListener("open-transcript-drawer", onOpen);
    try {
      const d = deps();
      await dispatchDeepAction(wire({ action: "open-meeting", meeting_id: "m-1" }), d);
      expect(d.navigateToMeeting).toHaveBeenCalledWith("m-1");
      vi.runAllTimers();
      expect(events).toHaveLength(0); // no transcript flag → no drawer

      await dispatchDeepAction(
        wire({ action: "open-meeting", meeting_id: "m-2", transcript: true }),
        d,
      );
      expect(d.navigateToMeeting).toHaveBeenLastCalledWith("m-2");
      expect(events).toHaveLength(0); // not before navigation settles
      vi.runAllTimers();
      expect(events).toEqual(["open-transcript-drawer"]);
    } finally {
      document.removeEventListener("open-transcript-drawer", onOpen);
    }
  });

  it("open-meeting without an id is ignored", async () => {
    const d = deps();
    await dispatchDeepAction(wire({ action: "open-meeting" }), d);
    expect(d.navigateToMeeting).not.toHaveBeenCalled();
  });

  it("search parks the palette query in uiStore (empty q opens the palette plain)", async () => {
    const d = deps();
    await dispatchDeepAction(wire({ action: "search", q: 'speaker:"Amy" budget' }), d);
    expect(useUIStore.getState().pendingPaletteQuery).toBe('speaker:"Amy" budget');

    await dispatchDeepAction(wire({ action: "search" }), d);
    expect(useUIStore.getState().pendingPaletteQuery).toBe("");
  });

  it("unknown actions from a newer backend are ignored, never thrown", async () => {
    const d = deps();
    await expect(
      dispatchDeepAction(wire({ action: "frobnicate" }), d),
    ).resolves.toBeUndefined();
    expect(d.createNewMeeting).not.toHaveBeenCalled();
    expect(d.navigateToMeeting).not.toHaveBeenCalled();
  });
});
