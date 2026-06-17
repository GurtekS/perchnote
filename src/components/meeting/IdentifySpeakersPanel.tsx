import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Pause, Check, Loader2, Sparkles, Wand2 } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, UnknownSpeaker } from "../../lib/ipc";
import { toUserMessage } from "../../lib/errors";
import { toast } from "../../stores/toastStore";

interface Props {
  meetingId: string;
  /** Focus this speaker's name input on open — the transcript's inline
   *  speaker pills route renames here instead of a third bespoke editor. */
  initialSpeaker?: string | null;
}

export function IdentifySpeakersPanel({ meetingId, initialSpeaker }: Props) {
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
        // Backend clears the meeting's speaker labels (old keys are stale
        // after re-clustering), so refresh anything that displays them.
        qc.invalidateQueries({ queryKey: ["speakerLabels", meetingId] }),
      ]);
      toast.success(`Detected ${count} speaker${count === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(toUserMessage(e), "Re-detect failed");
    } finally {
      setReclustering(false);
    }
  };

  // Naming and merging both rewrite what the transcript and speaker
  // surfaces display — refresh all of it so changes carry over immediately.
  const refreshSpeakerData = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["unknown-speakers", meetingId] }),
      qc.invalidateQueries({ queryKey: ["speakerLabels", meetingId] }),
      qc.invalidateQueries({ queryKey: ["transcript", meetingId] }),
    ]);

  const merge = async (fromKey: string, intoKey: string) => {
    try {
      const changed = await ipc.mergeSpeakers(meetingId, fromKey, intoKey);
      toast.success(`Merged. ${changed} segment${changed === 1 ? "" : "s"} reassigned.`);
      await refreshSpeakerData();
    } catch (e) {
      toast.error(toUserMessage(e), "Merge failed");
    }
  };

  if (isLoading) {
    return <p className="text-xs text-text-muted">Looking for speakers…</p>;
  }

  const recordingUrl = recordingPath ? convertFileSrc(recordingPath) : "";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">Speakers</h3>
        <button
          type="button"
          onClick={reclusterAndRefresh}
          disabled={reclustering}
          title="Recompute speaker groupings using voice similarity across the full recording (clears existing names)"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-caption text-text-secondary border border-border hover:bg-bg-hover disabled:opacity-50"
        >
          <Wand2 size={11} />
          {reclustering ? "Re-detecting…" : "Re-detect speakers"}
        </button>
      </div>
      {speakers.length === 0 ? (
        <p className="text-xs text-text-muted">
          No speakers detected in this meeting yet. Record (or re-detect) to find them.
        </p>
      ) : (
        <>
          <p className="text-xs text-text-muted">
            Play a sample to hear each speaker, name them (names show everywhere and are
            remembered across meetings), and merge any duplicates the detector split apart.
          </p>
          <ul className="space-y-2 list-none p-0 m-0">
            {speakers.map((s) => (
              <SpeakerRow
                key={s.speaker_key}
                meetingId={meetingId}
                speaker={s}
                others={speakers.filter((o) => o.speaker_key !== s.speaker_key)}
                recordingUrl={recordingUrl}
                autoFocus={s.speaker_key === initialSpeaker}
                onSaved={refreshSpeakerData}
                onMerge={merge}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SpeakerRow({
  meetingId, speaker, others, recordingUrl, autoFocus = false, onSaved, onMerge,
}: {
  meetingId: string;
  speaker: UnknownSpeaker;
  others: UnknownSpeaker[];
  recordingUrl: string;
  autoFocus?: boolean;
  onSaved: () => void;
  onMerge: (fromKey: string, intoKey: string) => void;
}) {
  const [name, setName] = useState(speaker.display_name ?? speaker.suggested_name ?? "");
  const [saving, setSaving] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Land the user on the right rename field when a speaker pill in the
  // transcript opened this panel.
  useEffect(() => {
    if (!autoFocus) return;
    const input = nameInputRef.current;
    input?.scrollIntoView?.({ block: "nearest" });
    input?.focus();
    input?.select();
  }, [autoFocus]);

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
      toast.error(toUserMessage(e), "Couldn't save the name");
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
          {speaker.display_name && <span className="text-success"> · named</span>}
        </span>
        <div className="flex items-center gap-2">
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Who is this?"
            aria-label={`Name for ${speaker.speaker_key}`}
            className="flex-1 px-2 py-1 text-sm rounded border border-border bg-bg-tertiary text-text-primary focus:outline-none focus:border-accent"
          />
          {speaker.suggested_name && (
            <span
              className="inline-flex items-center gap-1 text-footnote text-accent"
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
        <span className="inline-flex items-center gap-1">{saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Save</span>
      </button>
      {others.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onMerge(speaker.speaker_key, e.target.value);
          }}
          aria-label={`Merge ${speaker.speaker_key} into another speaker`}
          title="Same person detected twice? Fold this speaker into the right one."
          className="h-7 max-w-[110px] rounded-md border border-border bg-bg-tertiary px-1.5 text-caption text-text-muted hover:text-text-secondary focus:outline-none focus:border-accent"
        >
          <option value="">Merge into…</option>
          {others.map((o) => (
            <option key={o.speaker_key} value={o.speaker_key}>
              {o.display_name || o.speaker_key}
            </option>
          ))}
        </select>
      )}
      <audio ref={audioRef} src={recordingUrl} preload="none" />
    </li>
  );
}
