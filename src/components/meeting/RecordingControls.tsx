import { useState, useEffect } from "react";

interface RecordingControlsProps {
  isRecording: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
}

/**
 * Minimal recording controls: a single Record/Stop button.
 * No pause, no VU meter, no timer — those live elsewhere.
 */
export function RecordingControls({
  isRecording,
  onStart,
  onStop,
  disabled,
}: RecordingControlsProps) {
  const [showSaved, setShowSaved] = useState(false);

  // Brief "Recording saved" indicator after stopping
  useEffect(() => {
    if (!isRecording && showSaved) {
      const timer = setTimeout(() => setShowSaved(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [isRecording, showSaved]);

  const handleStop = () => {
    onStop();
    setShowSaved(true);
  };

  return (
    <div className="flex items-center gap-2">
      {isRecording ? (
        <button
          onClick={handleStop}
          className="w-9 h-9 rounded-full bg-recording hover:bg-recording-pulse flex items-center justify-center transition-all recording-pulse"
          title="Stop recording"
        >
          {/* Stop icon: small white square */}
          <div className="w-3 h-3 bg-white rounded-sm" />
        </button>
      ) : (
        <>
          <button
            onClick={onStart}
            disabled={disabled}
            className="w-9 h-9 rounded-full bg-recording/80 hover:bg-recording disabled:opacity-50 flex items-center justify-center transition-all"
            title="Start recording"
          >
            {/* Record icon: white circle */}
            <div className="w-3.5 h-3.5 bg-white rounded-full" />
          </button>
          {showSaved && (
            <span className="saved-indicator text-xs text-text-muted flex items-center gap-1">
              Recording saved
            </span>
          )}
        </>
      )}
    </div>
  );
}
