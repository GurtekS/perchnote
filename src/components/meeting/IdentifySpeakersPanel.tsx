import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Pause, Check, Sparkles, Wand2 } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, UnknownSpeaker } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";

interface Props {
  meetingId: string;
}

export function IdentifySpeakersPanel({ meetingId }: Props) {
  const qc = useQueryClient();
  const [reclustering, setReclustering] = useState(false);

  const { data: speakers = [], isLoading } = useQuery({
    queryKey: ["unknown-speakers", meetingId],
    queryFn: () => ipc.unknownSpeakersForMeeting(meetingId),
  });

  const { data: recordingPath } = useQuery({
    queryKey: ["recording-url", meetingId],
    queryFn: () => ipc.getRecordingUrl(meetingId),
    enabled: speakers.length > 0,
    retry: false,
  });

  const reclusterAndRefresh = async () => {
    setReclustering(true);
    try {
      const count = await ipc.reclusterSpeakers(meetingId);
      // Re-clustering rewrites segment.speaker, so invalidate everything
      // that derives from the transcript.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["unknown-speakers", meetingId] }),
        qc.invalidateQueries({ queryKey: ["transcript", meetingId] }),
      ]);
      toast.success(`Detected ${count} speaker${count === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(`Re-detect failed: ${String(e)}`);
    } finally {
      setReclustering(false);
    }
  };

  if (isLoading) {
    return <p className="text-xs text-text-muted">Looking for unnamed speakers…</p>;
  }

  const recordingUrl = recordingPath ? convertFileSrc(recordingPath) : "";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">Identify speakers</h3>
        <button
          type="button"
          onClick={reclusterAndRefresh}
          disabled={reclustering}
          title="Recompute speaker groupings using voice similarity across the full recording"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-text-secondary border border-border hover:bg-bg-hover disabled:opacity-50"
        >
          <Wand2 size={11} />
          {reclustering ? "Re-detecting…" : "Re-detect speakers"}
        </button>
      </div>
      {speakers.length === 0 ? (
        <p className="text-xs text-text-muted">
          All speakers in this meeting are already named. If the labels look wrong, use
          Re-detect speakers above to recompute them from the recording.
        </p>
      ) : (
        <>
          <p className="text-xs text-text-muted">
            Listen to a sample from each unnamed speaker and tell us who it is. Names you pick are remembered across meetings.
          </p>
          <ul className="space-y-2 list-none p-0 m-0">
            {speakers.map((s) => (
              <SpeakerRow
                key={s.speaker_key}
                meetingId={meetingId}
                speaker={s}
                recordingUrl={recordingUrl}
                onSaved={() => qc.invalidateQueries({ queryKey: ["unknown-speakers", meetingId] })}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SpeakerRow({
  meetingId, speaker, recordingUrl, onSaved,
}: {
  meetingId: string;
  speaker: UnknownSpeaker;
  recordingUrl: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(speaker.suggested_name ?? "");
  const [saving, setSaving] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, []);

  const playSnippet = () => {
    const a = audioRef.current;
    if (!a || !recordingUrl) return;
    a.currentTime = speaker.longest_start_ms / 1000;
    a.play();
    const stopAt = speaker.longest_end_ms / 1000;
    const stopper = () => {
      if (a.currentTime >= stopAt) {
        a.pause();
        a.removeEventListener("timeupdate", stopper);
      }
    };
    a.addEventListener("timeupdate", stopper);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await ipc.identifySpeaker(
        meetingId, speaker.speaker_key, trimmed,
        speaker.longest_start_ms, speaker.longest_end_ms,
      );
      toast.success(`${speaker.speaker_key} identified as ${trimmed}`);
      onSaved();
    } catch (e) {
      toast.error(`Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="flex items-center gap-2 p-2 rounded-lg border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={playing ? () => audioRef.current?.pause() : playSnippet}
        disabled={!recordingUrl}
        className="flex items-center justify-center w-7 h-7 rounded-full bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-30"
        aria-label={playing ? "Pause snippet" : "Play snippet"}
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-xs text-text-muted">
          {speaker.speaker_key} · {speaker.total_seconds}s of talking
        </span>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Who is this?"
            className="flex-1 px-2 py-1 text-sm rounded border border-border bg-bg-tertiary text-text-primary focus:outline-none focus:border-accent"
          />
          {speaker.suggested_name && (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-accent"
              title={`cosine ${speaker.suggested_similarity?.toFixed(2)}`}
            >
              <Sparkles size={10} /> {speaker.suggested_name}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={!name.trim() || saving}
        className="px-3 py-1.5 rounded-md bg-accent text-white text-xs disabled:opacity-50 hover:bg-accent/90"
      >
        {saving ? "Saving…" : <span className="inline-flex items-center gap-1"><Check size={11} /> Save</span>}
      </button>
      <audio ref={audioRef} src={recordingUrl} preload="none" />
    </li>
  );
}
