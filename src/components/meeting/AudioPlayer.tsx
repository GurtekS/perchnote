import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

interface AudioPlayerProps {
  meetingId: string;
  /** Current playback time in ms — exposed for timestamp syncing */
  onTimeUpdate?: (timeMs: number) => void;
  /** Seek to a specific timestamp in ms */
  seekToMs?: number;
  /** Monotonic counter to force re-seek even when seekToMs hasn't changed */
  seekNonce?: number;
}

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Audio playback component for recorded meetings .
 * Provides play/pause, seek, and speed controls.
 * When paired with the transcript drawer, supports timestamp-synced playback.
 */
export function AudioPlayer({ meetingId, onTimeUpdate, seekToMs, seekNonce }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(true);

  // Load the WAV file path from the backend
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke<string | null>("get_recording_path", { meetingId }).then((path) => {
      if (cancelled) return;
      if (path) {
        // Use convertFileSrc to create an asset:// URL for Tauri
        setAudioSrc(convertFileSrc(path));
      } else {
        setAudioSrc(null);
      }
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [meetingId]);

  // Seek when parent requests it 
  useEffect(() => {
    if (seekToMs !== undefined && audioRef.current) {
      audioRef.current.currentTime = seekToMs / 1000;
    }
  }, [seekToMs, seekNonce]);

  // Time update handler
  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    onTimeUpdate?.(Math.floor(audio.currentTime * 1000));
  }, [onTimeUpdate]);

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = parseFloat(e.target.value);
    setCurrentTime(audio.currentTime);
  };

  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  };

  const cycleSpeed = () => {
    const idx = PLAYBACK_SPEEDS.indexOf(speed);
    const nextIdx = (idx + 1) % PLAYBACK_SPEEDS.length;
    const newSpeed = PLAYBACK_SPEEDS[nextIdx];
    setSpeed(newSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = newSpeed;
    }
  };

  const formatTime = (s: number) => {
    if (!isFinite(s) || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  if (loading) {
    return null;
  }

  if (!audioSrc) {
    return null; // No recording available
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-tertiary/50">
      <audio
        ref={audioRef}
        src={audioSrc}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
        preload="metadata"
      />

      {/* Skip back */}
      <button
        onClick={() => skip(-10)}
        className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
        title="Back 10s"
      >
        <SkipBack size={12} />
      </button>

      {/* Play/Pause */}
      <button
        onClick={togglePlay}
        className="p-1.5 rounded-full bg-accent hover:bg-accent-hover text-white transition-colors"
        title={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
      </button>

      {/* Skip forward */}
      <button
        onClick={() => skip(10)}
        className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
        title="Forward 10s"
      >
        <SkipForward size={12} />
      </button>

      {/* Time display */}
      <span className="text-caption font-mono text-text-muted w-16 text-center shrink-0">
        {formatTime(currentTime)}
      </span>

      {/* Seek bar */}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={currentTime}
        onChange={handleSeek}
        className="flex-1 h-1 accent-accent cursor-pointer"
      />

      {/* Duration */}
      <span className="text-caption font-mono text-text-muted w-16 text-center shrink-0">
        {formatTime(duration)}
      </span>

      {/* Speed control */}
      <button
        onClick={cycleSpeed}
        className="text-caption font-mono text-text-secondary hover:text-accent px-1.5 py-0.5 rounded bg-bg-primary border border-border transition-colors"
        title="Playback speed"
      >
        {speed}x
      </button>
    </div>
  );
}
