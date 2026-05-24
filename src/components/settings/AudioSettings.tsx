import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw, Mic, Globe, Play, Download, Check, Loader2, Trash2, User } from "lucide-react";
import { ipc, ModelInfo } from "../../lib/ipc";
import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "../../stores/toastStore";
import { Toggle } from "../shared/Toggle";
import {
  InlineSettingsStatus,
  SettingsSectionHeader,
  SettingsStatusBadge,
  SettingsSubsectionHeader,
  primarySettingsButtonClass,
  secondarySettingsButtonClass,
  settingsInputClass,
} from "./settingsUi";

const LANGUAGES = [
  { id: "auto", label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "nl", label: "Dutch" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "zh", label: "Chinese" },
  { id: "ar", label: "Arabic" },
  { id: "ru", label: "Russian" },
  { id: "hi", label: "Hindi" },
  { id: "pl", label: "Polish" },
  { id: "sv", label: "Swedish" },
  { id: "da", label: "Danish" },
  { id: "no", label: "Norwegian" },
  { id: "fi", label: "Finnish" },
  { id: "tr", label: "Turkish" },
  { id: "uk", label: "Ukrainian" },
  { id: "vi", label: "Vietnamese" },
  { id: "th", label: "Thai" },
  { id: "id", label: "Indonesian" },
  { id: "cs", label: "Czech" },
  { id: "ro", label: "Romanian" },
  { id: "hu", label: "Hungarian" },
  { id: "el", label: "Greek" },
  { id: "he", label: "Hebrew" },
];


export function AudioSettings() {
  const queryClient = useQueryClient();

  const {
    data: devices = [],
    error: devicesError,
    isLoading: devicesLoading,
    refetch: refetchDevices,
  } = useQuery({
    queryKey: ["audio-devices"],
    queryFn: () => invoke<string[]>("list_audio_devices"),
    retry: false,
    staleTime: Infinity,
  });

  const { data: savedDevice } = useQuery({
    queryKey: ["setting", "audio_device"],
    queryFn: () => ipc.getSetting("audio_device"),
  });

  const { data: savedModel } = useQuery({
    queryKey: ["setting", "whisper_model"],
    queryFn: () => ipc.getSetting("whisper_model"),
  });

  const { data: savedLanguage } = useQuery({
    queryKey: ["setting", "whisper_language"],
    queryFn: () => ipc.getSetting("whisper_language"),
  });

  const { data: savedNoiseCancellation } = useQuery({
    queryKey: ["setting", "noise_cancellation"],
    queryFn: () => ipc.getSetting("noise_cancellation"),
  });

  const { data: savedCaptureSystemAudio } = useQuery({
    queryKey: ["setting", "capture_system_audio"],
    queryFn: () => ipc.getSetting("capture_system_audio"),
  });

  const { data: savedCustomVocabulary = "" } = useQuery({
    queryKey: ["setting", "custom_vocabulary"],
    queryFn: () => ipc.getSetting("custom_vocabulary").then((v) => v ?? ""),
  });

  const vocabDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCustomVocabularyChange = (value: string) => {
    if (vocabDebounceRef.current) clearTimeout(vocabDebounceRef.current);
    vocabDebounceRef.current = setTimeout(async () => {
      await ipc.setSetting("custom_vocabulary", value);
      queryClient.invalidateQueries({ queryKey: ["setting", "custom_vocabulary"] });
    }, 600);
  };

  const {
    data: whisperModels = [],
    error: whisperModelsError,
    isLoading: whisperModelsLoading,
  } = useQuery<ModelInfo[]>({
    queryKey: ["whisper-models"],
    queryFn: ipc.listWhisperModels,
    retry: false,
  });

  const [selectedDevice, setSelectedDevice] = useState("");
  const [selectedModel, setSelectedModel] = useState("medium.en");
  const [selectedLanguage, setSelectedLanguage] = useState("auto");
  const [noiseCancellation, setNoiseCancellation] = useState(true);
  const [captureSystemAudio, setCaptureSystemAudio] = useState(true);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [downloading, setDownloading] = useState<string | null>(null);
  const readyModels = whisperModels.filter((model) => model.downloaded).length;
  const audioReady = !devicesError && !whisperModelsError && devices.length > 0 && readyModels > 0;

  useEffect(() => { if (savedDevice) setSelectedDevice(savedDevice); }, [savedDevice]);
  useEffect(() => { if (savedModel) setSelectedModel(savedModel); }, [savedModel]);
  useEffect(() => { if (savedLanguage) setSelectedLanguage(savedLanguage); }, [savedLanguage]);
  useEffect(() => { if (savedNoiseCancellation !== undefined && savedNoiseCancellation !== null) setNoiseCancellation(savedNoiseCancellation === "true"); }, [savedNoiseCancellation]);
  useEffect(() => { if (savedCaptureSystemAudio !== undefined && savedCaptureSystemAudio !== null) setCaptureSystemAudio(savedCaptureSystemAudio === "true"); }, [savedCaptureSystemAudio]);

  // Listen to download progress events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ model_id: string; progress: number }>("model-download-progress", (event) => {
      setDownloadProgress((prev) => ({
        ...prev,
        [event.payload.model_id]: event.payload.progress,
      }));
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  const handleDeviceChange = async (device: string) => {
    setSelectedDevice(device);
    await ipc.setSetting("audio_device", device || "");
    toast.success("Audio device updated");
  };

  const handleModelChange = async (model: string) => {
    setSelectedModel(model);
    await ipc.setSetting("whisper_model", model);
    queryClient.invalidateQueries({ queryKey: ["setting", "whisper_model"] });
    toast.success(`Transcription model set to ${model}`);
  };

  const handleDownloadModel = async (modelId: string) => {
    setDownloading(modelId);
    try {
      await ipc.downloadWhisperModel(modelId);
      queryClient.invalidateQueries({ queryKey: ["whisper-models"] });
      toast.success("Model downloaded successfully");
    } catch (e) {
      toast.error("Download failed: " + String(e));
    } finally {
      setDownloading(null);
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    }
  };

  const handleLanguageChange = async (lang: string) => {
    setSelectedLanguage(lang);
    await ipc.setSetting("whisper_language", lang);
    queryClient.invalidateQueries({ queryKey: ["setting", "whisper_language"] });
    const label = LANGUAGES.find((l) => l.id === lang)?.label || lang;
    toast.success(`Transcription language set to ${label}`);
  };

  const handleCaptureSystemAudioToggle = async () => {
    const newValue = !captureSystemAudio;
    setCaptureSystemAudio(newValue);
    await ipc.setSetting("capture_system_audio", newValue ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "capture_system_audio"] });
    toast.success(newValue ? "System audio capture enabled" : "System audio capture disabled");
  };

  const handleNoiseCancellationToggle = async () => {
    const newValue = !noiseCancellation;
    setNoiseCancellation(newValue);
    await ipc.setSetting("noise_cancellation", newValue ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "noise_cancellation"] });
    toast.success(newValue ? "Noise cancellation enabled" : "Noise cancellation disabled");
  };

  return (
    <div className="space-y-6">
      <SettingsSectionHeader
        title="Audio"
        description="Choose the recording input, transcription model, language, and speaker recognition settings used for meetings."
        badge={
          <SettingsStatusBadge
            tone={audioReady ? "ok" : devicesLoading || whisperModelsLoading ? "neutral" : "warn"}
            isLoading={devicesLoading || whisperModelsLoading}
          >
            {audioReady ? "ready" : devicesLoading || whisperModelsLoading ? "checking" : "needs attention"}
          </SettingsStatusBadge>
        }
      />

      {devicesError && (
        <InlineSettingsStatus
          role="alert"
          tone="error"
          title="Audio device check failed"
          message={String(devicesError)}
        />
      )}
      {whisperModelsError && (
        <InlineSettingsStatus
          role="alert"
          tone="error"
          title="Transcription model check failed"
          message={String(whisperModelsError)}
        />
      )}

      {/* Microphone Section */}
      <section>
        <SettingsSubsectionHeader
          title="Microphone"
          description="Select the microphone to use for recording meetings."
          action={
            <SettingsStatusBadge
              tone={devicesError ? "error" : devices.length > 0 ? "ok" : "warn"}
              isLoading={devicesLoading}
            >
              {devicesLoading ? "checking" : devices.length > 0 ? `${devices.length} devices` : "no devices"}
            </SettingsStatusBadge>
          }
        />

        <div className="flex items-center gap-2 mb-3">
          <select
            value={selectedDevice}
            onChange={(e) => handleDeviceChange(e.target.value)}
            className={`${settingsInputClass} min-h-10 flex-1`}
          >
            <option value="">System Default</option>
            {devices.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => refetchDevices()}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
            title="Refresh devices"
            aria-label="Refresh audio devices"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <MicrophoneTest />
      </section>

      {/* Transcription Section */}
      <section>
        <SettingsSubsectionHeader
          title="Transcription"
          description="Configure how your meetings are transcribed."
          action={
            <SettingsStatusBadge
              tone={whisperModelsError ? "error" : readyModels > 0 ? "ok" : "warn"}
              isLoading={whisperModelsLoading}
            >
              {whisperModelsLoading ? "checking" : readyModels > 0 ? `${readyModels} ready` : "download needed"}
            </SettingsStatusBadge>
          }
        />

        {/* Model Picker */}
        <div className="mb-4">
          <label className="text-xs text-text-muted block mb-1.5">Model</label>
          {whisperModels.length > 0 ? (
            <div className="space-y-2">
              {whisperModels.map((model) => {
                const isSelected = selectedModel === model.id;
                const isDownloading = downloading === model.id;
                const progress = downloadProgress[model.id];

                return (
                  <div
                    key={model.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                      isSelected ? "border-accent bg-accent/5" : "border-border"
                    }`}
                  >
                    {/* Radio */}
                    <input
                      type="radio"
                      name="whisper-model"
                      value={model.id}
                      checked={isSelected}
                      onChange={() => model.downloaded && handleModelChange(model.id)}
                      disabled={!model.downloaded}
                      className="w-4 h-4 shrink-0 accent-accent"
                    />
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-text-primary">{model.label}</span>
                      <p className="text-xs text-text-muted">{model.size}</p>
                    </div>
                    {/* Status / action */}
                    <div className="shrink-0">
                      {model.downloaded ? (
                        <SettingsStatusBadge tone="ok"><Check size={12} /> Ready</SettingsStatusBadge>
                      ) : isDownloading ? (
                        <div className="flex items-center gap-2 min-w-[80px]">
                          <Loader2 size={11} className="animate-spin text-accent shrink-0" />
                          <div className="flex flex-col gap-0.5 flex-1">
                            <span className="text-[10px] text-accent font-mono text-right">
                              {progress !== undefined ? `${Math.round(progress)}%` : "…"}
                            </span>
                            <div className="h-1 bg-bg-hover rounded-full overflow-hidden">
                              <div
                                className="h-full bg-accent rounded-full transition-all duration-300"
                                style={{ width: progress !== undefined ? `${Math.round(progress)}%` : "0%" }}
                              />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleDownloadModel(model.id)}
                          disabled={!!downloading}
                          className={`${primarySettingsButtonClass} min-h-8 px-2 py-1 text-[11px]`}
                        >
                          <Download size={11} />
                          Download
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2">
              <label
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  selectedModel === "base.en"
                    ? "border-accent bg-accent/5"
                    : "border-border hover:bg-bg-tertiary"
                }`}
              >
                <input
                  type="radio"
                  name="whisper-model"
                  value="base.en"
                  checked={selectedModel === "base.en"}
                  onChange={() => handleModelChange("base.en")}
                  className="w-4 h-4 shrink-0 mt-0.5 accent-accent"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">Fast (Base)</span>
                  <p className="text-xs text-text-muted">~148 MB · Lower accuracy, faster processing</p>
                </div>
              </label>
              <label
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  selectedModel !== "base.en"
                    ? "border-accent bg-accent/5"
                    : "border-border hover:bg-bg-tertiary"
                }`}
              >
                <input
                  type="radio"
                  name="whisper-model"
                  value="large-v3-turbo"
                  checked={selectedModel !== "base.en"}
                  onChange={() => handleModelChange("large-v3-turbo")}
                  className="w-4 h-4 shrink-0 mt-0.5 accent-accent"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">Accurate (Large)</span>
                  <p className="text-xs text-text-muted">~3.1 GB · Best accuracy, slower processing</p>
                </div>
              </label>
            </div>
          )}
        </div>

        {/* Language Picker */}
        <div className="mb-4">
          <label className="flex items-center gap-1 text-xs text-text-muted mb-1.5">
            <Globe size={10} />
            Language
          </label>
          <select
            value={selectedLanguage}
            onChange={(e) => handleLanguageChange(e.target.value)}
            className={`${settingsInputClass} w-full`}
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.id} value={lang.id}>{lang.label}</option>
            ))}
          </select>
        </div>

        {/* System Audio Toggle */}
        <div className="space-y-2">
          <div className="flex items-start gap-4 p-3 rounded-lg border border-border bg-bg-tertiary">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">Capture system audio</span>
              <p className="text-xs text-text-muted mt-0.5">
                Record audio playing on your Mac (requires Screen Recording permission).
                {captureSystemAudio === false && " If prompted, grant access in System Settings — macOS will restart the app automatically."}
              </p>
            </div>
            <Toggle enabled={captureSystemAudio} onChange={handleCaptureSystemAudioToggle} />
          </div>

          {/* Noise Cancellation Toggle */}
          <div className="flex items-start gap-4 p-3 rounded-lg border border-border bg-bg-tertiary">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">Noise cancellation</span>
              <p className="text-xs text-text-muted mt-0.5">Reduce background noise before transcription</p>
            </div>
            <Toggle enabled={noiseCancellation} onChange={handleNoiseCancellationToggle} />
          </div>
        </div>
      </section>
      {/* Custom Vocabulary */}
      <section>
        <SettingsSubsectionHeader
          title="Custom Vocabulary"
          description="Add words or phrases that may be transcribed incorrectly - project names, people, acronyms. Comma-separated."
        />
        <textarea
          key={savedCustomVocabulary}
          defaultValue={savedCustomVocabulary}
          onChange={(e) => handleCustomVocabularyChange(e.target.value)}
          placeholder="E.g. Figma, Kubernetes, GPT-4, Project Dolfin…"
          rows={3}
          className={`${settingsInputClass} w-full resize-none`}
        />
      </section>

      {/* Speaker Profiles Section */}
      <section>
        <SettingsSubsectionHeader
          title="Speaker Profiles"
          description="Record voice samples so the app can recognize speakers in future meetings."
        />
        <SpeakerProfilesSection />
      </section>
    </div>
  );
}

/** Speaker profiles — list, add, delete */
function SpeakerProfilesSection() {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);

  const { data: profiles = [] } = useQuery({
    queryKey: ["voice-profiles"],
    queryFn: ipc.listVoiceProfiles,
  });

  const handleDelete = async (id: string) => {
    await ipc.deleteVoiceProfile(id);
    queryClient.invalidateQueries({ queryKey: ["voice-profiles"] });
    toast.success("Voice profile deleted");
  };

  return (
    <div className="space-y-2">
      {profiles.length === 0 ? (
        <p className="text-xs text-text-muted py-2">No voice profiles saved yet.</p>
      ) : (
        profiles.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg-tertiary"
          >
            <div className="w-7 h-7 rounded-full bg-accent/10 text-accent flex items-center justify-center shrink-0">
              <User size={13} />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary truncate block">
                {p.speaker_name}
              </span>
              <span className="text-[10px] text-text-muted">Voice sample recorded</span>
            </div>
            <button
              onClick={() => handleDelete(p.id)}
              className="p-1.5 rounded-md text-text-muted hover:text-recording hover:bg-recording/10 transition-colors"
              title="Delete profile"
              aria-label={`Delete voice profile ${p.speaker_name}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))
      )}
      <button
        onClick={() => setShowDialog(true)}
        className={secondarySettingsButtonClass}
      >
        <Mic size={14} />
        + Record voice sample
      </button>
      {showDialog && (
        <RecordVoiceDialog
          onClose={() => setShowDialog(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["voice-profiles"] });
            setShowDialog(false);
          }}
        />
      )}
    </div>
  );
}

/** Record a 5-second voice sample and save it as a profile */
function RecordVoiceDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "recording" | "saving">("idle");
  const [countdown, setCountdown] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleRecord = async () => {
    if (!name.trim()) {
      setError("Enter a name first");
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false } });
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessor to capture raw PCM
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      const samples: Float32Array[] = [];

      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        samples.push(new Float32Array(data));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      setState("recording");
      let remaining = 5;
      setCountdown(remaining);

      intervalRef.current = setInterval(async () => {
        remaining--;
        setCountdown(remaining);
        if (remaining <= 0) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          processor.disconnect();
          source.disconnect();
          stream.getTracks().forEach((t) => t.stop());

          // Combine captured samples
          const totalLen = samples.reduce((acc, s) => acc + s.length, 0);
          const combined = new Float32Array(totalLen);
          let offset = 0;
          for (const s of samples) { combined.set(s, offset); offset += s.length; }

          // Resample to 16kHz
          const srcRate = audioCtx.sampleRate;
          const ratio = srcRate / 16000;
          const targetLen = Math.floor(combined.length / ratio);
          const resampled = new Float32Array(targetLen);
          for (let i = 0; i < targetLen; i++) {
            resampled[i] = combined[Math.floor(i * ratio)];
          }
          audioCtx.close();

          setState("saving");
          try {
            await ipc.saveVoiceProfile(name.trim(), Array.from(resampled));
            toast.success(`Voice profile "${name.trim()}" saved`);
            onSaved();
          } catch (e) {
            setError("Failed to save: " + String(e));
            setState("idle");
          }
        }
      }, 1000);
    } catch {
      setError("Microphone access denied. Check your permissions.");
      setState("idle");
    }
  };

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  return (
    <div className="mt-2 p-4 rounded-lg border border-accent/30 bg-accent/5 space-y-3">
      <p className="text-xs font-semibold text-text-primary">Record voice sample (5 seconds)</p>

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Person name (e.g. Alice)"
        disabled={state !== "idle"}
        className={`${settingsInputClass} w-full disabled:opacity-50`}
      />

      {error && <p className="text-xs text-recording">{error}</p>}

      <div className="flex gap-2">
        {state === "idle" && (
          <>
            <button
              onClick={handleRecord}
              disabled={!name.trim()}
              className={primarySettingsButtonClass}
            >
              <Mic size={13} />
              Start recording
            </button>
            <button
              onClick={onClose}
              className={secondarySettingsButtonClass}
            >
              Cancel
            </button>
          </>
        )}
        {state === "recording" && (
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-recording animate-pulse" />
            <span className="text-sm text-recording font-medium">Recording... {countdown}s</span>
          </div>
        )}
        {state === "saving" && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 size={13} className="animate-spin" />
            Saving profile...
          </div>
        )}
      </div>
    </div>
  );
}

/** Test microphone: records 3 seconds and plays it back */
function MicrophoneTest() {
  const [state, setState] = useState<"idle" | "recording" | "playing">("idle");
  const [countdown, setCountdown] = useState(3);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cleanup = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const handleTest = async () => {
    if (state !== "idle") return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;

        setState("playing");
        audio.play().catch(() => setState("idle"));
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setState("idle");
        };
      };

      recorder.start();
      setState("recording");
      setCountdown(3);

      let remaining = 3;
      intervalRef.current = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);
        if (remaining <= 0) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          recorder.stop();
        }
      }, 1000);
    } catch {
      toast.error("Could not access microphone. Check your permissions.");
      setState("idle");
    }
  };

  return (
    <button
      onClick={handleTest}
      disabled={state !== "idle"}
      className={`${secondarySettingsButtonClass} disabled:opacity-60`}
    >
      {state === "idle" && (
        <>
          <Mic size={14} />
          Test microphone
        </>
      )}
      {state === "recording" && (
        <>
          <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          Recording... {countdown}s
        </>
      )}
      {state === "playing" && (
        <>
          <Play size={14} />
          Playing back...
        </>
      )}
    </button>
  );
}
