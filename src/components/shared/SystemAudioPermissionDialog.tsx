import { useEffect, useRef, useState } from "react";
import { MonitorSpeaker } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useRecordingStore } from "../../stores/recordingStore";
import { useFocusTrap } from "../../hooks/useFocusTrap";

// macOS deep link to the Screen Recording privacy pane.
const SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * Shown when a recording is blocked because "Capture system audio" is on but
 * the app lacks Screen Recording permission — without it the CoreAudio process
 * tap runs but yields pure silence, silently dropping every participant's audio.
 *
 * Mounted once at the app root and driven entirely by the recording store, so
 * it works regardless of which screen started the recording.
 */
export function SystemAudioPermissionDialog() {
  const open = useRecordingStore((s) => s.systemAudioPermissionRequired);
  const recordMicOnly = useRecordingStore((s) => s.recordMicOnly);
  const dismiss = useRecordingStore((s) => s.dismissPermissionDialog);

  // Once the user has been sent to grant permission, switch the copy to the
  // "granted — now restart" guidance (a fresh grant only reaches the process
  // tap after a relaunch).
  const [requested, setRequested] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(open, dialogRef, dismiss);

  useEffect(() => {
    if (!open) {
      setRequested(false);
      return;
    }
    // Land keyboard users on the primary action.
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open, requested]);

  if (!open) return null;

  const handleGrant = async () => {
    try {
      // Shows the OS prompt the first time; afterwards it's a no-op, so we also
      // open the Settings pane as a reliable fallback.
      await ipc.requestSystemAudioPermission();
    } catch {
      // Best effort — fall through to opening System Settings.
    }
    try {
      await ipc.openUrl(SCREEN_RECORDING_SETTINGS_URL);
    } catch {
      // Ignore — the user can open System Settings manually.
    }
    setRequested(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={dismiss}
      />
      <div
        ref={dialogRef}
        className="glass-float relative rounded-xl max-w-sm w-full mx-4 p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-audio-permission-title"
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 w-9 h-9 rounded-full bg-recording/10 flex items-center justify-center">
            <MonitorSpeaker size={18} className="text-recording" />
          </div>
          <div>
            <h3 id="system-audio-permission-title" className="text-sm font-semibold text-text-primary">
              Can&apos;t capture system audio
            </h3>
            {requested ? (
              <p className="text-sm text-text-secondary mt-1">
                Enable <span className="font-medium">Perchnote</span> under{" "}
                <span className="font-medium">Screen&nbsp;Recording</span> in System
                Settings, then <span className="font-medium">restart Perchnote</span>{" "}
                for it to take effect.
              </p>
            ) : (
              <p className="text-sm text-text-secondary mt-1">
                Screen Recording permission is needed to record other
                participants&apos; audio. Without it, only your microphone is
                captured.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {!requested && (
            <button
              onClick={handleGrant}
              className="btn btn-primary w-full"
            >
              Grant Permission
            </button>
          )}
          {requested && (
            <button
              onClick={() => ipc.openUrl(SCREEN_RECORDING_SETTINGS_URL)}
              className="btn btn-primary w-full"
            >
              Open System Settings
            </button>
          )}
          <button
            onClick={recordMicOnly}
            className="btn btn-secondary w-full"
          >
            Record mic-only
          </button>
          <button
            onClick={dismiss}
            className="btn btn-ghost w-full"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
