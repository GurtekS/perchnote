import { useState, useEffect } from "react";
import { Square } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useRecordingStore } from "../../stores/recordingStore";

export function MeetingBanner() {
  const { isRecording, isPaused, meetingId, startedAt, stopRecording } = useRecordingStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Tick-driven render; elapsed itself derives from startedAt so it can't
  // drift from the meeting header's clock or reset when the sidebar remounts.
  const [, setTick] = useState(0);
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  if (!isRecording) return null;

  const base = startedAt ?? mountedAt; // resume-sync fallback: count from mount
  const duration = Math.max(0, Math.floor((Date.now() - base) / 1000));
  const m = Math.floor(duration / 60);
  const s = duration % 60;
  const formatted = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;

  const handleStop = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const stoppedId = await stopRecording();
    // Same contract as the tray stop: land on the meeting (PostRecordingScreen
    // takes it from there) and refresh everything keyed on status. The old
    // bare store call left stale "recording" rows in every list.
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    if (stoppedId) {
      queryClient.invalidateQueries({ queryKey: ["meeting", stoppedId] });
      navigate({ to: "/meeting/$id", params: { id: stoppedId } });
    }
  };

  return (
    <Link
      to="/meeting/$id"
      params={{ id: meetingId || "" }}
      className={`block px-3 py-2 border-b transition-colors ${
        isPaused
          ? "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15"
          : "bg-recording/10 border-recording/20 hover:bg-recording/15"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          {!isPaused && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-recording-pulse opacity-75" />
          )}
          <span
            className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
              isPaused ? "bg-amber-500" : "bg-recording"
            }`}
          />
        </span>
        <span
          className={`text-xs font-medium truncate flex-1 ${
            isPaused ? "text-amber-500" : "text-recording"
          }`}
        >
          {isPaused ? "Paused" : "Recording…"}
        </span>
        <span className="text-xs text-text-muted font-mono tabular-nums">{formatted}</span>
        <button
          onClick={handleStop}
          aria-label="Stop recording"
          title="Stop recording"
          className="p-1 rounded hover:bg-recording/20 text-recording transition-colors"
        >
          <Square size={12} fill="currentColor" />
        </button>
      </div>
    </Link>
  );
}
