import { useState, useEffect } from "react";
import { Square } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useRecordingStore } from "../../stores/recordingStore";

export function MeetingBanner() {
  const { isRecording, meetingId, stopRecording } = useRecordingStore();
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!isRecording) {
      setDuration(0);
      return;
    }
    const interval = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  if (!isRecording) return null;

  const m = Math.floor(duration / 60);
  const s = duration % 60;
  const formatted = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;

  return (
    <Link
      to="/meeting/$id"
      params={{ id: meetingId || "" }}
      className="block px-3 py-2 bg-recording/10 border-b border-recording/20 hover:bg-recording/15 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-recording-pulse opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-recording" />
        </span>
        <span className="text-xs font-medium text-recording truncate flex-1">
          Recording...
        </span>
        <span className="text-xs text-text-muted font-mono tabular-nums">{formatted}</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            stopRecording();
          }}
          className="p-1 rounded hover:bg-recording/20 text-recording transition-colors"
        >
          <Square size={12} fill="currentColor" />
        </button>
      </div>
    </Link>
  );
}
