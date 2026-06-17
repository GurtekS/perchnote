import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw, Mic, Globe, Play, Download, Check, Loader2, Trash2, User } from "lucide-react";
import { ipc, ModelInfo } from "../../lib/ipc";
import { announce } from "../../lib/announce";
import { toUserMessage } from "../../lib/errors";
import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "../../stores/toastStore";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { Toggle } from "../shared/Toggle";
import {
  InlineSettingsStatus,
  SettingsSectionHeader,
  SettingsStatusBadge,
  SettingsSubsectionHeader,
  primarySettingsButtonClass,
  primarySettingsButtonCompactClass,
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

  // Transcription engine (plan v9 #12): whisper default; Apple Speech only
  // selectable when the macOS 26+ SpeechTranscriber stack is present.
  const { data: speechEngineAvailable = false } = useQuery({
    queryKey: ["speech-engine-available"],
    queryFn: ipc.speechEngineAvailable,
    retry: false,
    staleTime: Infinity,
  });
  const { data: savedEngine } = useQuery({
    queryKey: ["setting", "transcription_engine"],
    queryFn: () => ipc.getSetting("transcription_engine"),
  });
  const transcriptionEngine = savedEngine === "apple" ? "apple" : "whisper";
  const handleEngineChange = async (engine: string) => {
    await ipc.setSetting("transcription_engine", engine);
    queryClient.invalidateQueries({ queryKey: ["setting", "transcription_engine"] });
    toast.success(
      engine === "apple"
        ? "Apple Speech engine selected for imports and re-transcription"
        : "Whisper engine selected",
    );
  };

  const { data: savedStereoRecording } = useQuery({
    queryKey: ["setting", "stereo_recording"],
    queryFn: () => ipc.getSetting("stereo_recording"),
  });
  const stereoRecording = savedStereoRecording === "true";
  const handleStereoRecordingToggle = async () => {
    const on = !stereoRecording;
    await ipc.setSetting("stereo_recording", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "stereo_recording"] });
    toast.success(
      on
        ? "Stereo from your next recording — you left, them right"
        : "Back to mono from your next recording",
    );
  };

  const { data: savedAccuracyPass } = useQuery({
    queryKey: ["setting", "accuracy_pass"],
    queryFn: () => ipc.getSetting("accuracy_pass"),
  });
  const accuracyPass = savedAccuracyPass !== "false"; // default on
  const handleAccuracyPassToggle = async () => {
    const on = !accuracyPass;
    await ipc.setSetting("accuracy_pass", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "accuracy_pass"] });
    toast.success(
      on
        ? "Recordings get a full-quality re-decode after they finish"
        : "Accuracy pass off — transcripts keep the live decode",
    );
  };

  const { data: savedAutoDiarize } = useQuery({
    queryKey: ["setting", "auto_diarize"],
    queryFn: () => ipc.getSetting("auto_diarize"),
  });
  const autoDiarize = savedAutoDiarize !== "false"; // default on
  const handleAutoDiarizeToggle = async () => {
    const on = !autoDiarize;
    await ipc.setSetting("auto_diarize", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "auto_diarize"] });
    toast.success(
      on
        ? "Speakers are detected — and named from your voice profiles — after each recording"
        : "Automatic speaker detection off — use Re-detect in the Speakers panel",
    );
  };

  const { data: savedEchoCancellation } = useQuery({
    queryKey: ["setting", "echo_cancellation"],
    queryFn: () => ipc.getSetting("echo_cancellation"),
  });
  const echoCancellation = savedEchoCancellation === "true";
  const handleEchoCancellationToggle = async () => {
    const on = !echoCancellation;
    await ipc.setSetting("echo_cancellation", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "echo_cancellation"] });
    toast.success(
      on
        ? "Echo cancellation from your next recording"
        : "Echo cancellation off from your next recording",
    );
  };

  const { data: callDetection = "" } = useQuery({
    queryKey: ["setting", "call_detection"],
    queryFn: () => ipc.getSetting("call_detection").then((v) => v ?? ""),
  });

  const { data: vadReady = false, refetch: refetchVad } = useQuery({
    queryKey: ["vad-model-ready"],
    queryFn: ipc.vadModelReady,
  });
  const [downloadingVad, setDownloadingVad] = useState(false);
  const handleDownloadVad = async () => {
    setDownloadingVad(true);
    try {
      await ipc.downloadVadModel();
      await refetchVad();
      toast.success("Voice activity filter active from your next recording");
    } catch (e) {
      toast.error(toUserMessage(e), "Download failed");
    } finally {
      setDownloadingVad(false);
    }
  };

  const { data: savedTopicTrackers = "" } = useQuery({
    queryKey: ["setting", "topic_trackers"],
    queryFn: () => ipc.getSetting("topic_trackers").then((v) => v ?? ""),
  });
  const topicDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTopicTrackersChange = (value: string) => {
    if (topicDebounceRef.current) clearTimeout(topicDebounceRef.current);
    topicDebounceRef.current = setTimeout(async () => {
      await ipc.setSetting("topic_trackers", value);
      queryClient.invalidateQueries({ queryKey: ["setting", "topic_trackers"] });
    }, 600);
  };

  const handleCallDetectionChange = async (on: boolean) => {
    await ipc.setSetting("call_detection", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "call_detection"] });
    toast.success(on ? "Call detection on" : "Call detection off");
  };

  const { data: savedCaptureSystemAudio } = useQuery({
    queryKey: ["setting", "capture_system_audio"],
    queryFn: () => ipc.getSetting("capture_system_audio"),
  });

  // Live Screen Recording permission state. Without it the system-audio tap
  // runs but produces only silence, so we surface the status (and a Grant
  // shortcut) right next to the toggle.
  const { data: hasSystemAudioPermission, refetch: refetchSystemAudioPermission } =
    useQuery({
      queryKey: ["system-audio-permission"],
      queryFn: ipc.checkSystemAudioPermission,
      retry: false,
    });

  const handleGrantSystemAudio = async () => {
    try {
      await ipc.requestSystemAudioPermission();
    } catch {
      // Best effort — fall through to opening System Settings.
    }
    try {
      await ipc.openUrl(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    } catch {
      // Ignore — user can open System Settings manually.
    }
    await refetchSystemAudioPermission();
  };

  const { data: savedCustomVocabulary = "" } = useQuery({
    queryKey: ["setting", "custom_vocabulary"],
    queryFn: () => ipc.getSetting("custom_vocabulary").then((v) => v ?? ""),
  });

  const { data: correctionRules = [] } = useQuery({
    queryKey: ["correction-rules"],
    queryFn: () => import("../../lib/correctionRules").then((m) => m.loadCorrectionRules()),
  });
  const handleRemoveRule = async (find: string) => {
    const { removeCorrectionRule } = await import("../../lib/correctionRules");
    await removeCorrectionRule(find);
    queryClient.invalidateQueries({ queryKey: ["correction-rules"] });
    toast.success("Rule removed — future transcripts keep the raw wording");
  };

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
      toast.error(toUserMessage(e), "Download failed");
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

        {/* Engine Picker (plan v9 #12) */}
        <div className="mb-4">
          <label className="text-xs text-text-muted block mb-1.5">Engine</label>
          <select
            value={transcriptionEngine}
            onChange={(e) => handleEngineChange(e.target.value)}
            className={`${settingsInputClass} w-full`}
            aria-label="Transcription engine"
          >
            <option value="whisper">Whisper (default)</option>
            <option
              value="apple"
              disabled={!speechEngineAvailable}
              title={
                speechEngineAvailable
                  ? undefined
                  : "Requires macOS 26 or later with Apple's speech model installed"
              }
            >
              Apple Speech (macOS 26+, beta)
            </option>
          </select>
          <p className="text-xs text-text-muted mt-1.5">
            {transcriptionEngine === "apple"
              ? "Apple's on-device engine — instant, no model download. Applies to imports and re-transcription in this version; live transcription still uses the Whisper model below."
              : speechEngineAvailable
                ? "Whisper runs fully on-device with the model below. Apple Speech (beta) is also available on this Mac — zero download, much faster for imports and re-transcription."
                : "Whisper runs fully on-device with the model below. Apple Speech requires macOS 26 or later."}
          </p>
        </div>

        {/* Model Picker */}
        <div className="mb-4">
          <label className="text-xs text-text-muted block mb-1.5">
            {transcriptionEngine === "apple" ? "Whisper model (live transcription)" : "Model"}
          </label>
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
                            <span className="text-footnote text-accent font-mono text-right">
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
                          className={`${primarySettingsButtonCompactClass}`}
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

        {/* Capture toggles — one grouped list (UI review #2: every toggle
            was its own full-width card; related switches read as one set) */}
        <div className="ios-group">
          <div className="ios-row !items-start">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">Capture system audio</span>
              <p className="text-xs text-text-muted mt-0.5">
                Record audio playing on your Mac (requires Screen Recording permission).
                {captureSystemAudio === false && " If prompted, grant access in System Settings — macOS will restart the app automatically."}
              </p>
            </div>
            <Toggle label="Capture system audio" enabled={captureSystemAudio} onChange={handleCaptureSystemAudioToggle} />
          </div>

          {/* Permission status — only relevant while capture is enabled. */}
          {captureSystemAudio && hasSystemAudioPermission === false && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-recording/30 bg-recording/5">
              <p className="text-xs text-text-secondary">
                <span className="font-medium text-recording">
                  Screen Recording permission not granted.
                </span>{" "}
                System audio won&apos;t be recorded until you enable it (a restart
                may be required).
              </p>
              <button
                onClick={handleGrantSystemAudio}
                className="shrink-0 px-2.5 py-1 text-xs rounded-md font-medium bg-accent hover:bg-accent-hover text-white transition-colors"
              >
                Grant
              </button>
            </div>
          )}
          {captureSystemAudio && hasSystemAudioPermission === true && (
            <p className="px-3 text-xs text-text-muted">
              <Check size={12} className="inline -mt-0.5 mr-1 text-green-500" />
              Screen Recording permission granted — system audio will be captured.
            </p>
          )}

          {/* Noise Cancellation Toggle */}
          <div className="ios-row !items-start">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">Noise cancellation</span>
              <p className="text-xs text-text-muted mt-0.5">Reduce background noise before transcription</p>
            </div>
            <Toggle label="Noise cancellation" enabled={noiseCancellation} onChange={handleNoiseCancellationToggle} />
          </div>

          {/* Stereo recording (plan v9 #9) */}
          <div className="ios-row !items-start">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">Stereo recording</span>
              <p className="text-xs text-text-muted mt-0.5">
                Your mic on the left channel, everyone else on the right — playback you can
                lateralize. Applies from the next recording; live transcription is
                unaffected, and stereo files downmix automatically when re-transcribed.
              </p>
            </div>
            <Toggle label="Stereo recording" enabled={stereoRecording} onChange={handleStereoRecordingToggle} />
          </div>

          {/* Echo cancellation (plan v9 #2) */}
          <div className="ios-row !items-start">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">
                Echo cancellation (experimental)
              </span>
              <p className="text-xs text-text-muted mt-0.5">
                For meetings on speakers without headphones. Uses the system
                voice-processing unit; applies from the next recording. Custom mic
                selection falls back to standard capture.
              </p>
            </div>
            <Toggle label="Echo cancellation" enabled={echoCancellation} onChange={handleEchoCancellationToggle} />
          </div>

          {/* Accuracy pass (plan v10 #3) */}
          <div className="ios-row !items-start">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">Accuracy pass</span>
              <p className="text-xs text-text-muted mt-0.5">
                After a recording finishes, re-transcribe the whole file in the
                background with full context — better punctuation and fewer
                misheard words. Your edits always win if they land first.
              </p>
            </div>
            <Toggle label="Accuracy pass" enabled={accuracyPass} onChange={handleAccuracyPassToggle} />
          </div>

          {/* Auto-diarize + auto-name (plan v10 #1) */}
          <div className="ios-row !items-start">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">
                Detect speakers automatically
              </span>
              <p className="text-xs text-text-muted mt-0.5">
                After a recording finishes, separate who said what in the
                background. Voices that clearly match a saved voice profile are
                named for you — with an Undo. Needs the speaker models (first
                Re-detect downloads them); all matching stays on this Mac.
              </p>
            </div>
            <Toggle label="Detect speakers automatically" enabled={autoDiarize} onChange={handleAutoDiarizeToggle} />
          </div>
        </div>
      </section>
      {/* Power-user features under one disclosure (UI review #2: the page
          was a 2,000px wall mixing daily settings with tuning knobs). */}
      <details className="group/adv">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-1 py-2 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary [&::-webkit-details-marker]:hidden">
          <span className="inline-block transition-transform group-open/adv:rotate-90">›</span>
          Advanced
          <span className="text-xs font-normal text-text-muted">
            vocabulary, correction rules, voice filter, topic trackers, call detection
          </span>
        </summary>
        <div className="space-y-6 pt-2">
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

      {/* Correction rules (plan v10 #5) */}
      <section>
        <SettingsSubsectionHeader
          title="Correction Rules"
          description='Fixes applied to every future transcript. Add one from the transcript drawer: replace a misheard word, then choose "Always make this fix".'
        />
        {correctionRules.length === 0 ? (
          <p className="text-xs text-text-muted">No rules yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {correctionRules.map((r) => (
              <li
                key={r.find}
                className="card flex items-center justify-between gap-3 px-3 py-1.5"
              >
                <span className="min-w-0 truncate text-xs text-text-primary">
                  “{r.find}” → “{r.replace}”
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveRule(r.find)}
                  aria-label={`Remove rule for ${r.find}`}
                  className="shrink-0 text-text-muted hover:text-text-primary"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* VAD gate */}
      <section>
        <SettingsSubsectionHeader
          title="Voice Activity Filter"
          description="A tiny on-device model (~1 MB) that screens out non-speech audio before transcription — fewer phantom phrases from keyboard noise, music, and silence."
        />
        {vadReady ? (
          <InlineSettingsStatus tone="ok" title="Active" message="Non-speech audio is filtered out before transcription" />
        ) : (
          <button
            onClick={handleDownloadVad}
            disabled={downloadingVad}
            className={secondarySettingsButtonClass}
          >
            {downloadingVad ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            Download filter model
          </button>
        )}
      </section>

      {/* Topic trackers */}
      <section>
        <SettingsSubsectionHeader
          title="Topic Trackers"
          description="Terms to track across every transcript — pricing, a project name, a competitor. They appear as clickable counters in the transcript drawer. Comma-separated."
        />
        <textarea
          key={savedTopicTrackers}
          defaultValue={savedTopicTrackers}
          onChange={(e) => handleTopicTrackersChange(e.target.value)}
          placeholder="E.g. pricing, Project Dolfin, churn…"
          rows={2}
          className={`${settingsInputClass} w-full resize-none`}
        />
      </section>

      {/* Call detection */}
      <section>
        <SettingsSubsectionHeader
          title="Call Detection"
          description="Get a nudge when a meeting app starts using your microphone and you're not recording. Only which app uses the mic is checked — never any audio."
        />
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={callDetection !== "false"}
            onChange={(e) => handleCallDetectionChange(e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span className="text-xs text-text-muted">
            Notify me when Zoom, Teams, my browser, or another call app goes live
          </span>
        </label>
      </section>

        </div>
      </details>

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

/** Speaker profiles — list, add, delete; multi-select for bulk delete
 *  (user request: "audio samples — give that bulk edit ability"). */
function SpeakerProfilesSection() {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const { data: profiles = [] } = useQuery({
    queryKey: ["voice-profiles"],
    queryFn: ipc.listVoiceProfiles,
  });

  // Deletes are irreversible (the sample WAV is removed) — confirm both
  // paths (deep review P2).
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "one"; id: string; name: string } | { kind: "bulk" } | null>(null);
  const handleDelete = async (id: string) => {
    await ipc.deleteVoiceProfile(id);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    queryClient.invalidateQueries({ queryKey: ["voice-profiles"] });
    toast.success("Voice profile deleted");
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteSelected = async () => {
    if (bulkBusy || selected.size === 0) return;
    setBulkBusy(true);
    let ok = 0;
    const failed = new Set<string>();
    for (const id of selected) {
      try {
        await ipc.deleteVoiceProfile(id);
        ok++;
      } catch {
        failed.add(id);
      }
    }
    queryClient.invalidateQueries({ queryKey: ["voice-profiles"] });
    setSelected(failed);
    setBulkBusy(false);
    if (failed.size > 0) {
      toast.error(`${ok} deleted — ${failed.size} couldn't be removed (still selected)`);
    } else {
      toast.success(`${ok} voice profile${ok === 1 ? "" : "s"} deleted`);
    }
  };

  const allSelected = profiles.length > 0 && selected.size === profiles.length;
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(profiles.map((p) => p.id)));
  };

  return (
    <div className="space-y-2">
      {profiles.length > 1 && (
        <label className="flex w-fit cursor-pointer items-center gap-2 px-1 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleSelectAll}
            aria-label="Select all voice profiles"
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          Select all
        </label>
      )}
      {selected.size > 0 && (
        <div className="card flex items-center gap-2 px-3 py-2">
          <span className="text-xs text-text-secondary">{selected.size} selected</span>
          <div className="flex-1" />
          <button
            onClick={() => setConfirmDelete({ kind: "bulk" })}
            disabled={bulkBusy}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-recording transition-colors hover:bg-recording/10 disabled:opacity-50"
          >
            <Trash2 size={12} />
            Delete selected
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:text-text-primary"
          >
            Clear
          </button>
        </div>
      )}
      {profiles.length === 0 ? (
        <p className="text-xs text-text-muted py-2">No voice profiles saved yet.</p>
      ) : (
        profiles.map((p) => (
          <div
            key={p.id}
            className="card flex items-center gap-3 p-3"
          >
            <input
              type="checkbox"
              checked={selected.has(p.id)}
              onChange={() => toggleSelected(p.id)}
              aria-label={`Select voice profile ${p.speaker_name}`}
              className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
            />
            <div className="w-7 h-7 rounded-full bg-accent/10 text-accent flex items-center justify-center shrink-0">
              <User size={13} />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary truncate block">
                {p.speaker_name}
              </span>
              <span className="text-footnote text-text-muted">Voice sample recorded</span>
            </div>
            <button
              onClick={() => setConfirmDelete({ kind: "one", id: p.id, name: p.speaker_name })}
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
      {confirmDelete && (
        <ConfirmDialog
          open={true}
          title="Delete voice profile?"
          message={
            confirmDelete.kind === "one"
              ? `“${confirmDelete.name}” and its voice sample will be deleted. Speakers already named in past meetings keep their names; future recordings won't auto-recognize this voice.`
              : `${selected.size} voice profile${selected.size !== 1 ? "s" : ""} and their samples will be deleted. This can't be undone.`
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => {
            const c = confirmDelete;
            setConfirmDelete(null);
            if (c.kind === "one") void handleDelete(c.id);
            else void deleteSelected();
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
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
      // Spoken progress for the visual-only "Recording... Ns" row. Every
      // second would be chatty over a 5s clip, so: start + final 3 ticks.
      announce("Recording voice sample — 5 seconds. Speak normally.");

      intervalRef.current = setInterval(async () => {
        remaining--;
        setCountdown(remaining);
        if (remaining > 0 && remaining <= 3) {
          announce(`${remaining} second${remaining === 1 ? "" : "s"} left`);
        }
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
          announce("Recording finished — saving voice profile…");
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

      {error && <p role="alert" className="text-xs text-recording">{error}</p>}

      <div className="flex gap-2">
        {state === "idle" && (
          <>
            <button
              onClick={handleRecord}
              disabled={!name.trim()}
              className={primarySettingsButtonClass}
            >
              <Mic size={14} />
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
      className={`${secondarySettingsButtonClass}`}
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
