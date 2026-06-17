import { useRecordingStore } from "../stores/recordingStore";
import { useUIStore } from "../stores/uiStore";

/**
 * Wire shape shared by the runtime `deep-action` event and the cold-start
 * `take_launch_deep_actions` drain — see LaunchDeepAction in
 * src-tauri/src/commands/deeplinks.rs. One shape, one dispatcher, so the
 * two delivery paths can't drift.
 */
export interface DeepActionWire {
  /** "record-start" | "record-stop" | "open-meeting" | "search" */
  action: string;
  meeting_id: string | null;
  title: string | null;
  transcript: boolean;
  q: string | null;
}

export interface DeepActionDeps {
  navigateToMeeting: (id: string) => void | Promise<void>;
  createNewMeeting: (title?: string) => void | Promise<void>;
}

/** MeetingView's open-transcript-drawer listener attaches in an effect after
 *  navigation commits — same handoff delay the pendingSeek flow uses. */
const TRANSCRIPT_DISPATCH_DELAY_MS = 250;

/** Handle one perchnote:// deep-link action. Used by the runtime event
 *  listener AND the cold-start drain in __root.tsx. */
export async function dispatchDeepAction(a: DeepActionWire, deps: DeepActionDeps): Promise<void> {
  switch (a.action) {
    case "record-start": {
      // Already recording → no-op (never start a second session).
      if (!useRecordingStore.getState().isRecording) {
        await deps.createNewMeeting(a.title ?? undefined);
      }
      break;
    }
    case "record-stop": {
      // Idle → no-op; this also makes record-stop harmless at cold start.
      const store = useRecordingStore.getState();
      if (store.isRecording) {
        const meetingId = await store.stopRecording();
        if (meetingId) await deps.navigateToMeeting(meetingId);
      }
      break;
    }
    case "open-meeting": {
      if (!a.meeting_id) break;
      await deps.navigateToMeeting(a.meeting_id);
      if (a.transcript) {
        setTimeout(() => {
          document.dispatchEvent(new CustomEvent("open-transcript-drawer"));
        }, TRANSCRIPT_DISPATCH_DELAY_MS);
      }
      break;
    }
    case "search": {
      useUIStore.getState().setPendingPaletteQuery(a.q ?? "");
      break;
    }
    // Unknown actions from a newer backend: ignore, never throw.
    default:
      break;
  }
}
