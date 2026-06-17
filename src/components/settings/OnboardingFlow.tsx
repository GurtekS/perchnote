import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  Calendar,
  Check,
  CheckCircle2,
  Cloud,
  HardDrive,
  KeyRound,
  Link2,
  Loader2,
  LockKeyhole,
  Mic,
  MonitorSpeaker,
  PlayCircle,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ipc, type ModelInfo } from "../../lib/ipc";
import { useOnboarding, type OnboardingProgress, type OnboardingStepId } from "../../hooks/useOnboarding";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import type { SettingsSection } from "./SettingsView";
import { primarySettingsButtonClass, secondarySettingsButtonClass } from "./settingsUi";

export type OnboardingFlowMode = "first-run" | "preview";
export type OnboardingRepairSection = Extract<SettingsSection, "audio" | "ai" | "calendar">;

interface OnboardingFlowProps {
  onComplete: () => void | Promise<void>;
  mode?: OnboardingFlowMode;
  onOpenSettingsSection?: (section: OnboardingRepairSection) => void;
}

type StepId = OnboardingStepId;
type AiProvider = "anthropic" | "ollama" | "apple";
type CalendarProvider = "google" | "microsoft";
type CalendarReadinessId = CalendarProvider | "ics";
type ReadinessTone = "neutral" | "ok" | "warn" | "error";

interface ReadinessStatus {
  badge: string;
  description: string;
  tone: ReadinessTone;
  isLoading?: boolean;
  error?: {
    title: string;
    message: string;
  };
}

interface OnboardingStep {
  id: StepId;
  label: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "privacy",
    label: "Privacy",
    title: "Local-first meeting capture",
    description: "Perchnote stores meetings on this Mac and keeps credentials in Keychain-backed settings.",
    icon: ShieldCheck,
  },
  {
    id: "audio",
    label: "Audio",
    title: "Check audio readiness",
    description: "Request microphone access now, or skip and allow it the first time you record.",
    icon: Mic,
  },
  {
    id: "ai",
    label: "AI",
    title: "Choose how notes are generated",
    description: "Pick a provider now or leave AI setup for Settings. Recording still works either way.",
    icon: Sparkles,
  },
  {
    id: "calendar",
    label: "Calendar",
    title: "Optional calendar connection",
    description: "Connect Google or Microsoft calendars when credentials are ready, or sync later.",
    icon: Calendar,
  },
  {
    id: "test",
    label: "Test",
    title: "Prove the pipeline",
    description: "Record five seconds of your voice and watch it transcribe, the same path every real meeting uses.",
    icon: Mic,
  },
  {
    id: "start",
    label: "Start",
    title: "Ready to capture meetings",
    description: "Create a meeting, press record, and Perchnote will keep the raw capture local.",
    icon: PlayCircle,
  },
];

const AI_OPTIONS: Array<{
  id: AiProvider;
  label: string;
  tagline: string;
  icon: LucideIcon;
}> = [
  {
    id: "anthropic",
    label: "Anthropic API",
    tagline: "Best quality with your API key stored through Keychain.",
    icon: Cloud,
  },
  {
    id: "ollama",
    label: "Ollama local",
    tagline: "Runs on this Mac when Ollama and a model are already installed.",
    icon: HardDrive,
  },
  {
    id: "apple",
    label: "Apple Intelligence",
    tagline: "On-device option for supported macOS releases.",
    icon: Sparkles,
  },
];

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";
const PRIMARY_BUTTON_CLASS = primarySettingsButtonClass;
const SECONDARY_BUTTON_CLASS = secondarySettingsButtonClass;

function getPrimaryActionLabel({
  configuredCalendarCount,
  hasAnthropicKey,
  isLastStep,
  isPreview,
  micStatus,
  stepId,
}: {
  configuredCalendarCount: number;
  hasAnthropicKey: boolean;
  isLastStep: boolean;
  isPreview: boolean;
  micStatus: "idle" | "checking" | "requested";
  stepId: StepId;
}) {
  if (isLastStep) return isPreview ? "Return to Today" : "Start using Perchnote";
  if (stepId === "privacy") return "Check audio";
  if (stepId === "audio") return micStatus === "requested" ? "Review AI options" : "Skip audio setup";
  if (stepId === "ai") return hasAnthropicKey ? "Review calendar options" : "Skip AI setup";
  if (stepId === "calendar") return configuredCalendarCount > 0 ? "Test your setup" : "Skip calendar setup";
  if (stepId === "test") return "Review start steps";
  return "Continue";
}

export function OnboardingFlow({
  onComplete,
  mode = "first-run",
  onOpenSettingsSection,
}: OnboardingFlowProps) {
  const isPreview = mode === "preview";
  const {
    progress: onboardingProgress,
    isLoading: onboardingProgressLoading,
    markStepViewed,
  } = useOnboarding();
  const [stepIndex, setStepIndex] = useState(0);
  const [hasAppliedResumeStep, setHasAppliedResumeStep] = useState(isPreview);
  const [micStatus, setMicStatus] = useState<"idle" | "checking" | "requested">("idle");
  const [screenStatus, setScreenStatus] = useState<"idle" | "checking" | "requested">("idle");
  const [audioError, setAudioError] = useState<string | null>(null);
  const [previewAiProvider, setPreviewAiProvider] = useState<AiProvider | null>(null);
  const [previewHasAnthropicKey, setPreviewHasAnthropicKey] = useState(false);
  const [previewCalendarConnections, setPreviewCalendarConnections] = useState<Record<CalendarProvider, boolean>>({
    google: false,
    microsoft: false,
  });
  const [anthropicKey, setAnthropicKey] = useState("");
  const [savingAnthropicKey, setSavingAnthropicKey] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [calendarSetup, setCalendarSetup] = useState<CalendarProvider | null>(null);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [microsoftClientId, setMicrosoftClientId] = useState("");
  const [microsoftClientSecret, setMicrosoftClientSecret] = useState("");
  const [connectingCalendar, setConnectingCalendar] = useState<CalendarProvider | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const queryClient = useQueryClient();

  const activeStep = ONBOARDING_STEPS[stepIndex];
  const ActiveStepIcon = activeStep.icon;
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === ONBOARDING_STEPS.length - 1;

  useEffect(() => {
    if (hasAppliedResumeStep) return;
    if (isPreview) {
      setHasAppliedResumeStep(true);
      return;
    }
    if (onboardingProgressLoading) return;

    setStepIndex(getResumeStepIndex(onboardingProgress));
    setHasAppliedResumeStep(true);
  }, [hasAppliedResumeStep, isPreview, onboardingProgress, onboardingProgressLoading]);

  useEffect(() => {
    if (isPreview || !hasAppliedResumeStep || onboardingProgressLoading) return;
    void markStepViewed(activeStep.id).catch(() => undefined);
  }, [activeStep.id, hasAppliedResumeStep, isPreview, markStepViewed, onboardingProgressLoading]);

  const {
    data: audioDevices = [],
    isLoading: audioDevicesLoading,
    error: audioDevicesError,
  } = useQuery<string[]>({
    queryKey: ["audio-devices"],
    queryFn: ipc.listAudioDevices,
    retry: false,
  });

  const {
    data: whisperModels = [],
    isLoading: whisperModelsLoading,
    error: whisperModelsError,
  } = useQuery<ModelInfo[]>({
    queryKey: ["whisper-models"],
    queryFn: ipc.listWhisperModels,
    retry: false,
  });

  const { data: storedAiProvider } = useQuery({
    queryKey: ["setting", "ai_provider"],
    queryFn: () => ipc.getSetting("ai_provider"),
    retry: false,
  });
  const aiProvider = previewAiProvider ?? ((storedAiProvider as AiProvider | null) ?? "anthropic");

  const {
    data: storedAnthropicKey,
    isLoading: anthropicKeyLoading,
    error: anthropicKeyError,
  } = useQuery({
    queryKey: ["setting", "anthropic_api_key"],
    queryFn: () => ipc.getSetting("anthropic_api_key"),
    retry: false,
  });
  const hasAnthropicKey = previewHasAnthropicKey || !!storedAnthropicKey;

  const {
    data: isOllamaRunning,
    isLoading: ollamaRunningLoading,
    error: ollamaRunningError,
  } = useQuery<boolean>({
    queryKey: ["ollama-running"],
    queryFn: ipc.isOllamaRunning,
    retry: false,
  });

  const {
    data: ollamaModels = [],
    isLoading: ollamaModelsLoading,
    error: ollamaModelsError,
  } = useQuery<string[]>({
    queryKey: ["ollama-models"],
    queryFn: ipc.listOllamaModels,
    enabled: isOllamaRunning === true,
    retry: false,
  });

  const {
    data: isAppleAiAvailable,
    isLoading: appleAiLoading,
    error: appleAiError,
  } = useQuery<boolean>({
    queryKey: ["apple-ai-available"],
    queryFn: ipc.isAppleAiAvailable,
    retry: false,
  });

  const {
    data: isGoogleConnected,
    isLoading: googleConnectedLoading,
    error: googleConnectedError,
  } = useQuery({
    queryKey: ["calendar-connected"],
    queryFn: ipc.isGoogleConnected,
    retry: false,
  });

  const {
    data: hasGoogleCredentials,
    isLoading: googleCredentialsLoading,
    error: googleCredentialsError,
  } = useQuery({
    queryKey: ["calendar-credentials", "google"],
    queryFn: ipc.hasGoogleCredentials,
    retry: false,
  });

  const {
    data: isMicrosoftConnected,
    isLoading: microsoftConnectedLoading,
    error: microsoftConnectedError,
  } = useQuery({
    queryKey: ["microsoft-connected"],
    queryFn: ipc.isMicrosoftConnected,
    retry: false,
  });

  const {
    data: hasMicrosoftCredentials,
    isLoading: microsoftCredentialsLoading,
    error: microsoftCredentialsError,
  } = useQuery({
    queryKey: ["calendar-credentials", "microsoft"],
    queryFn: ipc.hasMicrosoftCredentials,
    retry: false,
  });

  const {
    data: icsUrls = [],
    isLoading: icsUrlsLoading,
    error: icsUrlsError,
  } = useQuery<string[]>({
    queryKey: ["ics-urls"],
    queryFn: ipc.listIcsUrls,
    retry: false,
  });

  const googleConnected = !!isGoogleConnected || previewCalendarConnections.google;
  const microsoftConnected = !!isMicrosoftConnected || previewCalendarConnections.microsoft;
  const configuredCalendarCount = useMemo(
    () => Number(googleConnected) + Number(microsoftConnected) + Number(icsUrls.length > 0),
    [googleConnected, icsUrls.length, microsoftConnected],
  );
  const primaryActionLabel = getPrimaryActionLabel({
    configuredCalendarCount,
    hasAnthropicKey,
    isLastStep,
    isPreview,
    micStatus,
    stepId: activeStep.id,
  });

  const audioDeviceReadiness = useMemo(
    () => getAudioDeviceReadiness(audioDevices, audioDevicesLoading, audioDevicesError),
    [audioDevices, audioDevicesError, audioDevicesLoading],
  );

  const whisperReadiness = useMemo(
    () => getWhisperReadiness(whisperModels, whisperModelsLoading, whisperModelsError),
    [whisperModels, whisperModelsError, whisperModelsLoading],
  );

  const aiReadiness = useMemo<Record<AiProvider, ReadinessStatus>>(
    () => ({
      anthropic: getAnthropicReadiness(hasAnthropicKey, anthropicKeyLoading, anthropicKeyError),
      ollama: getOllamaReadiness(
        isOllamaRunning,
        ollamaRunningLoading,
        ollamaRunningError,
        ollamaModels,
        ollamaModelsLoading,
        ollamaModelsError,
      ),
      apple: getAppleAiReadiness(isAppleAiAvailable, appleAiLoading, appleAiError),
    }),
    [
      anthropicKeyError,
      anthropicKeyLoading,
      appleAiError,
      appleAiLoading,
      hasAnthropicKey,
      isAppleAiAvailable,
      isOllamaRunning,
      ollamaModels,
      ollamaModelsError,
      ollamaModelsLoading,
      ollamaRunningError,
      ollamaRunningLoading,
    ],
  );

  const calendarReadiness = useMemo<Record<CalendarReadinessId, ReadinessStatus>>(
    () => ({
      google: getCalendarProviderReadiness({
        label: "Google Calendar",
        connected: googleConnected,
        credentialsReady: !!hasGoogleCredentials,
        connectionLoading: googleConnectedLoading,
        credentialsLoading: googleCredentialsLoading,
        connectionError: googleConnectedError,
        credentialsError: googleCredentialsError,
      }),
      microsoft: getCalendarProviderReadiness({
        label: "Microsoft Calendar",
        connected: microsoftConnected,
        credentialsReady: !!hasMicrosoftCredentials,
        connectionLoading: microsoftConnectedLoading,
        credentialsLoading: microsoftCredentialsLoading,
        connectionError: microsoftConnectedError,
        credentialsError: microsoftCredentialsError,
      }),
      ics: getIcsReadiness(icsUrls, icsUrlsLoading, icsUrlsError),
    }),
    [
      googleConnected,
      googleConnectedError,
      googleConnectedLoading,
      googleCredentialsError,
      googleCredentialsLoading,
      hasGoogleCredentials,
      hasMicrosoftCredentials,
      icsUrls,
      icsUrlsError,
      icsUrlsLoading,
      microsoftConnected,
      microsoftConnectedError,
      microsoftConnectedLoading,
      microsoftCredentialsError,
      microsoftCredentialsLoading,
    ],
  );

  const goNext = async () => {
    if (isLastStep) {
      setIsCompleting(true);
      try {
        await onComplete();
      } catch (e) {
        toast.error(toUserMessage(e, "Could not complete onboarding"), "Could not complete onboarding");
      } finally {
        setIsCompleting(false);
      }
      return;
    }
    setStepIndex((current) => Math.min(current + 1, ONBOARDING_STEPS.length - 1));
  };

  const goBack = () => {
    setStepIndex((current) => Math.max(current - 1, 0));
  };

  const handleRequestMic = async () => {
    setMicStatus("checking");
    setAudioError(null);

    try {
      if (isPreview) {
        setMicStatus("requested");
        toast.success("Microphone check marked ready for preview");
        return;
      }

      // Persist progress before requesting permissions. macOS can restart the
      // app after permission changes, and this keeps first-run setup resumable
      // without marking the final completion setting.
      await markStepViewed("audio");

      let started = false;
      try {
        // mic-only probe: this checks Microphone permission, so don't let the
        // separate Screen Recording gate block it.
        await ipc.startRecording("permission-check", null, false);
        started = true;
      } catch {
        // Expected on systems where the probe only opens the permission dialog.
      }

      if (started) {
        try {
          await ipc.stopRecording();
        } catch {
          // The permission probe may not produce a complete recording session.
        }
      }

      setMicStatus("requested");
    } catch (e) {
      setMicStatus("idle");
      setAudioError(formatErrorMessage(e));
    }
  };

  const { data: hasScreenRecording = false, refetch: refetchScreenPermission } = useQuery({
    queryKey: ["system-audio-permission"],
    queryFn: ipc.checkSystemAudioPermission,
    retry: false,
    enabled: !isPreview,
  });

  const handleRequestScreenRecording = async () => {
    setScreenStatus("checking");
    try {
      if (isPreview) {
        setScreenStatus("requested");
        return;
      }
      await markStepViewed("audio");
      const granted = await ipc.requestSystemAudioPermission();
      setScreenStatus("requested");
      void refetchScreenPermission();
      if (granted) {
        toast.success("Screen Recording granted. Restart Perchnote before your first recording");
      } else {
        toast.info(
          "Enable Perchnote under System Settings → Privacy & Security → Screen Recording, then restart the app",
        );
      }
    } catch (e) {
      setScreenStatus("idle");
      toast.error(formatErrorMessage(e));
    }
  };

  // Background-download the default transcription model while the user walks
  // the wizard, so the first recording isn't blocked on a fetch (plan rank 5).
  // The backend command is idempotent — returns immediately if present.
  useEffect(() => {
    if (isPreview || !hasAppliedResumeStep) return;
    ipc
      .listWhisperModels()
      .then((models) => {
        const def = models.find((m) => m.id === "base.en");
        if (def && !def.downloaded) {
          ipc
            .downloadWhisperModel("base.en")
            .then(() => {
              queryClient.invalidateQueries({ queryKey: ["whisper-models"] });
              toast.success("Transcription model ready");
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPreview, hasAppliedResumeStep]);

  const [testStatus, setTestStatus] = useState<
    "idle" | "recording" | "transcribing" | "done" | "error"
  >("idle");
  const [testTranscript, setTestTranscript] = useState<string | null>(null);
  const [testCountdown, setTestCountdown] = useState(0);

  // Live pipeline proof (plan rank 5): record 5s through the REAL recording
  // path into a real (then soft-deleted) meeting and show the first segment.
  const handleTestStart = async () => {
    if (isPreview) {
      setTestTranscript("Preview mode. Transcription runs on real recordings.");
      setTestStatus("done");
      return;
    }
    setTestStatus("recording");
    setTestTranscript(null);
    let meetingId: string | null = null;
    try {
      const m = await ipc.createMeeting("Setup test (auto-deleted)");
      meetingId = m.id;
      await ipc.startRecording(m.id, null, false); // mic-only
      for (let s = 5; s > 0; s--) {
        setTestCountdown(s);
        await new Promise((r) => setTimeout(r, 1000));
      }
      setTestCountdown(0);
      setTestStatus("transcribing");
      await ipc.stopRecording();
      for (let i = 0; i < 60; i++) {
        const t = await ipc.getTranscriptByMeeting(m.id);
        if (t) {
          try {
            const segs = JSON.parse(t.segments || "[]") as Array<{ text?: string }>;
            const first = segs.find((s) => s.text && s.text.trim().length > 0);
            if (first) {
              setTestTranscript(first.text!.trim());
              setTestStatus("done");
              return;
            }
          } catch { /* keep polling */ }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      setTestStatus("error");
    } catch {
      setTestStatus("error");
      try { await ipc.stopRecording(); } catch { /* not recording */ }
    } finally {
      if (meetingId) {
        ipc.softDeleteMeeting(meetingId).catch(() => {});
        queryClient.invalidateQueries({ queryKey: ["meetings"] });
      }
    }
  };

  const handlePickAiProvider = async (provider: AiProvider) => {
    setAiError(null);
    if (isPreview) {
      setPreviewAiProvider(provider);
      toast.success("AI provider selected for preview");
      return;
    }

    try {
      await ipc.setSetting("ai_provider", provider);
      queryClient.invalidateQueries({ queryKey: ["setting", "ai_provider"] });
      toast.success("AI provider updated");
    } catch (e) {
      setAiError(`Could not save AI provider. ${formatErrorMessage(e)}`);
    }
  };

  const handleSaveAnthropicKey = async () => {
    const trimmed = anthropicKey.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("sk-ant-")) {
      setAiError("Anthropic API keys start with sk-ant-.");
      return;
    }

    if (isPreview) {
      setPreviewHasAnthropicKey(true);
      setAnthropicKey("");
      toast.success("API key accepted for preview");
      return;
    }

    setSavingAnthropicKey(true);
    setAiError(null);
    try {
      await ipc.setSetting("anthropic_api_key", trimmed);
      setAnthropicKey("");
      queryClient.invalidateQueries({ queryKey: ["setting", "anthropic_api_key"] });
      toast.success("API key saved to Keychain");
    } catch (e) {
      setAiError(`Could not save API key. ${formatErrorMessage(e)}`);
    } finally {
      setSavingAnthropicKey(false);
    }
  };

  const handleCalendarConnect = async (provider: CalendarProvider) => {
    const isGoogle = provider === "google";
    const clientId = isGoogle ? googleClientId.trim() : microsoftClientId.trim();
    const clientSecret = isGoogle ? googleClientSecret.trim() : microsoftClientSecret.trim();

    if (!clientId || !clientSecret) return;

    if (isPreview) {
      setPreviewCalendarConnections((current) => ({ ...current, [provider]: true }));
      if (isGoogle) {
        setGoogleClientId("");
        setGoogleClientSecret("");
      } else {
        setMicrosoftClientId("");
        setMicrosoftClientSecret("");
      }
      setCalendarSetup(null);
      toast.success(`${isGoogle ? "Google" : "Microsoft"} Calendar marked ready for preview`);
      return;
    }

    setConnectingCalendar(provider);
    setCalendarError(null);
    try {
      await ipc.setSetting(isGoogle ? "google_client_id" : "microsoft_client_id", clientId);
      await ipc.setSetting(isGoogle ? "google_client_secret" : "microsoft_client_secret", clientSecret);

      if (isGoogle) {
        await ipc.startGoogleOAuth();
        queryClient.invalidateQueries({ queryKey: ["calendar-connected"] });
        queryClient.invalidateQueries({ queryKey: ["calendar-credentials", "google"] });
        toast.success("Google Calendar connected");
      } else {
        await ipc.startMicrosoftOAuth();
        queryClient.invalidateQueries({ queryKey: ["microsoft-connected"] });
        queryClient.invalidateQueries({ queryKey: ["calendar-credentials", "microsoft"] });
        toast.success("Microsoft Calendar connected");
      }
    } catch (e) {
      setCalendarError(`Could not connect ${isGoogle ? "Google" : "Microsoft"} Calendar. ${formatErrorMessage(e)}`);
    } finally {
      setConnectingCalendar(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg-primary px-4 py-6">
      <div className="grid min-w-0 max-h-[calc(100vh-3rem)] w-full max-w-5xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-bg-secondary shadow-2xl md:grid-cols-[260px_1fr] md:grid-rows-none">
        <aside className="min-w-0 border-b border-border bg-bg-tertiary/60 p-3 md:border-b-0 md:border-r md:p-4">
          <div className="mb-3 flex items-end justify-between gap-3 md:mb-5 md:block">
            <p className="text-xs font-medium uppercase text-text-muted">Perchnote setup</p>
            <h1 className="mt-1 text-lg font-semibold text-text-primary">
              {isPreview ? "Preview" : "First run"}
            </h1>
          </div>

          <ol className="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-1 md:overflow-visible md:pb-0">
            {ONBOARDING_STEPS.map((item, index) => {
              const Icon = item.icon;
              const isActive = item.id === activeStep.id;
              const isComplete = index < stepIndex;

              return (
                <li key={item.id} className="shrink-0 md:shrink">
                  <button
                    type="button"
                    onClick={() => setStepIndex(index)}
                    className={`flex min-h-11 w-[136px] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors md:w-full ${FOCUS_RING} ${
                      isActive
                        ? "bg-accent/10 text-text-primary"
                        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    }`}
                    aria-current={isActive ? "step" : undefined}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
                        isActive || isComplete
                          ? "border-accent/40 bg-accent/15 text-accent"
                          : "border-border text-text-muted"
                      }`}
                    >
                      {isComplete ? <Check size={14} /> : <Icon size={14} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{item.label}</span>
                      <span className="block truncate text-caption text-text-muted">{item.title}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col overflow-y-auto p-5 md:min-h-[560px] md:p-8">
          <div className="mb-6">
            <div className="mb-4 flex gap-1.5">
              {ONBOARDING_STEPS.map((item, index) => (
                <div
                  key={item.id}
                  className={`h-1 flex-1 rounded-full ${
                    index <= stepIndex ? "bg-accent" : "bg-bg-tertiary"
                  }`}
                />
              ))}
            </div>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
                <ActiveStepIcon size={20} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase text-text-muted">
                  Step {stepIndex + 1} of {ONBOARDING_STEPS.length}
                </p>
                <h2 className="mt-1 text-xl font-semibold text-text-primary">{activeStep.title}</h2>
                <p className="mt-1 max-w-2xl text-sm text-text-secondary">{activeStep.description}</p>
              </div>
            </div>
          </div>

          <section className="flex-1">
            {activeStep.id === "privacy" && <PrivacyStep />}
            {activeStep.id === "audio" && (
              <AudioStep
                deviceReadiness={audioDeviceReadiness}
                error={audioError}
                isPreview={isPreview}
                status={micStatus}
                whisperReadiness={whisperReadiness}
                onOpenSettingsSection={onOpenSettingsSection}
                onRequestMic={handleRequestMic}
                screenStatus={screenStatus}
                hasScreenRecording={hasScreenRecording}
                onRequestScreenRecording={handleRequestScreenRecording}
              />
            )}
            {activeStep.id === "test" && (
              <TestStep
                status={testStatus}
                transcript={testTranscript}
                countdown={testCountdown}
                onStart={handleTestStart}
              />
            )}
            {activeStep.id === "ai" && (
              <AiStep
                aiProvider={aiProvider}
                anthropicKey={anthropicKey}
                error={aiError}
                hasAnthropicKey={hasAnthropicKey}
                isPreview={isPreview}
                readiness={aiReadiness}
                savingAnthropicKey={savingAnthropicKey}
                onAnthropicKeyChange={setAnthropicKey}
                onOpenSettingsSection={onOpenSettingsSection}
                onPickProvider={handlePickAiProvider}
                onSaveAnthropicKey={handleSaveAnthropicKey}
              />
            )}
            {activeStep.id === "calendar" && (
              <CalendarStep
                activeSetup={calendarSetup}
                configuredCount={configuredCalendarCount}
                connectingProvider={connectingCalendar}
                error={calendarError}
                googleClientId={googleClientId}
                googleClientSecret={googleClientSecret}
                isGoogleConnected={googleConnected}
                isMicrosoftConnected={microsoftConnected}
                isPreview={isPreview}
                microsoftClientId={microsoftClientId}
                microsoftClientSecret={microsoftClientSecret}
                readiness={calendarReadiness}
                onConnect={handleCalendarConnect}
                onGoogleClientIdChange={setGoogleClientId}
                onGoogleClientSecretChange={setGoogleClientSecret}
                onOpenSettingsSection={onOpenSettingsSection}
                onMicrosoftClientIdChange={setMicrosoftClientId}
                onMicrosoftClientSecretChange={setMicrosoftClientSecret}
                onSetupChange={setCalendarSetup}
              />
            )}
            {activeStep.id === "start" && (
              <StartStep
                aiProvider={aiProvider}
                configuredCalendarCount={configuredCalendarCount}
                hasAnthropicKey={hasAnthropicKey}
                micRequested={micStatus === "requested"}
              />
            )}
          </section>

          <footer className="sticky bottom-0 z-10 -mx-5 mt-8 flex flex-col gap-3 border-t border-border bg-bg-secondary px-5 pb-5 pt-4 sm:flex-row sm:items-center sm:justify-between md:static md:mx-0 md:bg-transparent md:px-0 md:pb-0">
            <button
              type="button"
              onClick={goBack}
              disabled={isFirstStep}
              className={`${SECONDARY_BUTTON_CLASS} min-w-[92px] disabled:opacity-40 sm:w-auto`}
            >
              <ArrowLeft size={14} />
              Back
            </button>

            <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
              <span className="hidden text-xs text-text-muted sm:inline">
                {isPreview
                  ? "Preview mode does not mark first-run setup complete."
                  : "Everything here can be changed later in Settings."}
              </span>
              <button
                type="button"
                onClick={goNext}
                disabled={isCompleting}
                aria-busy={isCompleting}
                className={`${PRIMARY_BUTTON_CLASS} w-full min-w-[132px] px-4 disabled:opacity-60 sm:w-auto`}
              >
                {isCompleting && <Loader2 size={14} className="animate-spin" />}
                {primaryActionLabel}
                <ArrowRight size={14} />
              </button>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

function PrivacyStep() {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <InfoTile
        icon={LockKeyhole}
        title="Local recordings"
        body="Meeting audio, transcripts, and notes stay in the app data folder unless you export or share them."
      />
      <InfoTile
        icon={KeyRound}
        title="Keychain secrets"
        body="OAuth client secrets, tokens, Slack webhooks, and Anthropic keys use the existing Keychain-backed setting keys."
      />
      <InfoTile
        icon={ShieldCheck}
        title="Optional services"
        body="Calendar sync and AI are enhancements. You can record and organize meetings without connecting either one."
      />
    </div>
  );
}

function AudioStep({
  deviceReadiness,
  error,
  isPreview,
  status,
  whisperReadiness,
  onOpenSettingsSection,
  onRequestMic,
  screenStatus,
  hasScreenRecording,
  onRequestScreenRecording,
}: {
  deviceReadiness: ReadinessStatus;
  error: string | null;
  isPreview: boolean;
  status: "idle" | "checking" | "requested";
  whisperReadiness: ReadinessStatus;
  onOpenSettingsSection?: (section: OnboardingRepairSection) => void;
  onRequestMic: () => void;
  screenStatus: "idle" | "checking" | "requested";
  hasScreenRecording: boolean;
  onRequestScreenRecording: () => void;
}) {
  const requested = status === "requested";
  const openAudioSettings = onOpenSettingsSection
    ? {
        label: "Open Audio Settings",
        onClick: () => onOpenSettingsSection("audio"),
      }
    : undefined;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              {requested ? <CheckCircle2 size={18} /> : <Mic size={18} />}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Microphone permission</h3>
              <p className="mt-1 text-sm text-text-secondary">
                {isPreview
                  ? "Preview mode marks audio readiness without opening macOS permission prompts."
                  : "This quick probe may open the macOS permission dialog. If macOS restarts the app after a permission change, your setup place is saved."}
              </p>
            </div>
          </div>
          <StatusBadge tone={requested ? "ok" : "neutral"}>
            {requested ? "requested" : "optional"}
          </StatusBadge>
        </div>

        {error && (
          <InlineIssue
            className="mt-3"
            title="Microphone permission check failed"
            message={`${error}. If you denied access, enable Perchnote under System Settings → Privacy & Security → Microphone, then try again.`}
          />
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRequestMic}
            disabled={status === "checking" || (requested && !error)}
            aria-busy={status === "checking"}
            className={`${PRIMARY_BUTTON_CLASS} min-w-[222px] disabled:opacity-60`}
          >
            {status === "checking" ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
            {error ? "Try again" : requested ? "Permission check requested" : "Request microphone access"}
          </button>
          <p className="text-xs text-text-muted">Skip for now if needed; recording will ask later.</p>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              {hasScreenRecording ? <CheckCircle2 size={18} /> : <MonitorSpeaker size={18} />}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Screen Recording permission</h3>
              <p className="mt-1 text-sm text-text-secondary">
                Needed to capture other participants&apos; audio in Zoom, Meet, and
                browser calls. A fresh grant takes effect after restarting Perchnote.
              </p>
            </div>
          </div>
          <StatusBadge tone={hasScreenRecording ? "ok" : "neutral"}>
            {hasScreenRecording ? "granted" : "optional"}
          </StatusBadge>
        </div>
        {!hasScreenRecording && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onRequestScreenRecording}
              disabled={screenStatus === "checking"}
              aria-busy={screenStatus === "checking"}
              className={`${PRIMARY_BUTTON_CLASS} min-w-[222px] disabled:opacity-60`}
            >
              {screenStatus === "checking" ? <Loader2 size={14} className="animate-spin" /> : <MonitorSpeaker size={14} />}
              {screenStatus === "requested" ? "Requested (restart to apply)" : "Request Screen Recording"}
            </button>
            <p className="text-xs text-text-muted">Skip to record mic-only; you can grant this later.</p>
          </div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <ReadinessCard
          icon={Mic}
          title="Audio device"
          status={deviceReadiness}
          action={openAudioSettings}
        />
        <ReadinessCard
          icon={HardDrive}
          title="Transcription model"
          status={whisperReadiness}
          action={openAudioSettings}
        />
      </div>
    </div>
  );
}

function TestStep({
  status,
  transcript,
  countdown,
  onStart,
}: {
  status: "idle" | "recording" | "transcribing" | "done" | "error";
  transcript: string | null;
  countdown: number;
  onStart: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            {status === "done" ? <CheckCircle2 size={18} /> : <Mic size={18} />}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Five-second test recording</h3>
            <p className="mt-1 text-sm text-text-secondary">
              Say a sentence out loud. This runs the exact capture → transcribe
              pipeline your meetings will use, then deletes itself.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onStart}
            disabled={status === "recording" || status === "transcribing"}
            aria-busy={status === "recording" || status === "transcribing"}
            className={`${PRIMARY_BUTTON_CLASS} min-w-[222px] disabled:opacity-60`}
          >
            {status === "recording" ? (
              <>Recording… {countdown}</>
            ) : status === "transcribing" ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Transcribing…
              </>
            ) : status === "done" || status === "error" ? (
              "Test again"
            ) : (
              "Start the test"
            )}
          </button>
          <p className="text-xs text-text-muted">Mic-only; nothing leaves this Mac.</p>
        </div>
        {status === "done" && transcript && (
          <div className="mt-4 rounded-lg border border-accent/20 bg-accent/5 p-3">
            <p className="section-label mb-1">Heard you say</p>
            <p className="text-sm text-text-primary">“{transcript}”</p>
          </div>
        )}
        {status === "error" && (
          <InlineIssue
            className="mt-3"
            title="No transcript came back"
            message="Check the microphone permission above, make sure a transcription model finished downloading, and try again."
          />
        )}
      </div>
    </div>
  );
}

function AiStep({
  aiProvider,
  anthropicKey,
  error,
  hasAnthropicKey,
  isPreview,
  readiness,
  savingAnthropicKey,
  onAnthropicKeyChange,
  onOpenSettingsSection,
  onPickProvider,
  onSaveAnthropicKey,
}: {
  aiProvider: AiProvider;
  anthropicKey: string;
  error: string | null;
  hasAnthropicKey: boolean;
  isPreview: boolean;
  readiness: Record<AiProvider, ReadinessStatus>;
  savingAnthropicKey: boolean;
  onAnthropicKeyChange: (value: string) => void;
  onOpenSettingsSection?: (section: OnboardingRepairSection) => void;
  onPickProvider: (provider: AiProvider) => void;
  onSaveAnthropicKey: () => void;
}) {
  return (
    <div className="space-y-4">
      {error && (
        <InlineIssue title="AI setup action failed" message={error} />
      )}

      <div className="grid gap-3 md:grid-cols-3">
        {AI_OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = aiProvider === option.id;
          const status = readiness[option.id];

          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onPickProvider(option.id)}
              className={`min-h-[176px] rounded-lg border p-3 text-left transition-colors ${FOCUS_RING} ${
                selected
                  ? "border-accent bg-accent/10"
                  : "border-border bg-bg-tertiary hover:border-text-muted"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Icon size={16} />
                </span>
                {selected && <CheckCircle2 size={16} className="text-accent" />}
              </div>
              <h3 className="text-sm font-semibold text-text-primary">{option.label}</h3>
              <p className="mt-1 text-xs text-text-muted">{option.tagline}</p>
              <InlineReadinessStatus status={status} />
            </button>
          );
        })}
      </div>

      {aiProvider === "anthropic" && (
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Anthropic API key</h3>
              <p className="mt-1 text-xs text-text-muted">
                Optional during onboarding. A saved key is routed through the existing Keychain setting.
              </p>
            </div>
            <StatusBadge tone={hasAnthropicKey ? "ok" : "neutral"}>
              {hasAnthropicKey ? "key set" : "not set"}
            </StatusBadge>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={anthropicKey}
              onChange={(event) => onAnthropicKeyChange(event.target.value)}
              placeholder={hasAnthropicKey ? "Paste a new key to replace" : "sk-ant-…"}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-border bg-bg-secondary px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={onSaveAnthropicKey}
              disabled={!anthropicKey.trim() || savingAnthropicKey}
              aria-busy={savingAnthropicKey}
              className={`${PRIMARY_BUTTON_CLASS} min-w-[116px]`}
            >
              {savingAnthropicKey && <Loader2 size={14} className="animate-spin" />}
              {isPreview ? "Use for preview" : "Save key"}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-secondary">
          You can finish setup without an AI provider. Perchnote will still capture meetings, store transcripts, and let you configure notes later.
        </p>
        {onOpenSettingsSection && (
          <SettingsRepairButton
            label="Open AI Settings"
            onClick={() => onOpenSettingsSection("ai")}
          />
        )}
      </div>
    </div>
  );
}

function CalendarStep({
  activeSetup,
  configuredCount,
  connectingProvider,
  error,
  googleClientId,
  googleClientSecret,
  isGoogleConnected,
  isMicrosoftConnected,
  isPreview,
  microsoftClientId,
  microsoftClientSecret,
  readiness,
  onConnect,
  onGoogleClientIdChange,
  onGoogleClientSecretChange,
  onOpenSettingsSection,
  onMicrosoftClientIdChange,
  onMicrosoftClientSecretChange,
  onSetupChange,
}: {
  activeSetup: CalendarProvider | null;
  configuredCount: number;
  connectingProvider: CalendarProvider | null;
  error: string | null;
  googleClientId: string;
  googleClientSecret: string;
  isGoogleConnected: boolean;
  isMicrosoftConnected: boolean;
  isPreview: boolean;
  microsoftClientId: string;
  microsoftClientSecret: string;
  readiness: Record<CalendarReadinessId, ReadinessStatus>;
  onConnect: (provider: CalendarProvider) => void;
  onGoogleClientIdChange: (value: string) => void;
  onGoogleClientSecretChange: (value: string) => void;
  onOpenSettingsSection?: (section: OnboardingRepairSection) => void;
  onMicrosoftClientIdChange: (value: string) => void;
  onMicrosoftClientSecretChange: (value: string) => void;
  onSetupChange: (provider: CalendarProvider | null) => void;
}) {
  const openCalendarSettings = onOpenSettingsSection
    ? () => onOpenSettingsSection("calendar")
    : undefined;

  return (
    <div className="space-y-4">
      <div className="card flex items-center justify-between px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Calendar sync status</h3>
          <p className="mt-1 text-xs text-text-muted">
            {configuredCount > 0
              ? "Connected calendars can populate upcoming meetings automatically."
              : "No calendar is required. Skip this step and create meetings manually from Today."}
          </p>
        </div>
        <StatusBadge tone={configuredCount > 0 ? "ok" : "neutral"}>
          {configuredCount > 0 ? `${configuredCount} configured` : "none connected"}
        </StatusBadge>
      </div>

      {error && (
        <InlineIssue title="Calendar setup action failed" message={error} />
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <CalendarProviderPanel
          clientId={googleClientId}
          clientSecret={googleClientSecret}
          connected={isGoogleConnected}
          isConnecting={connectingProvider === "google"}
          isOpen={activeSetup === "google"}
          isPreview={isPreview}
          label="Google Calendar"
          onOpenSettings={openCalendarSettings}
          provider="google"
          readiness={readiness.google}
          setupNote="Requires a Google Cloud project with Calendar API enabled."
          onClientIdChange={onGoogleClientIdChange}
          onClientSecretChange={onGoogleClientSecretChange}
          onConnect={onConnect}
          onToggle={() => onSetupChange(activeSetup === "google" ? null : "google")}
        />
        <CalendarProviderPanel
          clientId={microsoftClientId}
          clientSecret={microsoftClientSecret}
          connected={isMicrosoftConnected}
          isConnecting={connectingProvider === "microsoft"}
          isOpen={activeSetup === "microsoft"}
          isPreview={isPreview}
          label="Microsoft Calendar"
          onOpenSettings={openCalendarSettings}
          provider="microsoft"
          readiness={readiness.microsoft}
          setupNote="Requires an Azure app registration with Calendar.Read permission."
          onClientIdChange={onMicrosoftClientIdChange}
          onClientSecretChange={onMicrosoftClientSecretChange}
          onConnect={onConnect}
          onToggle={() => onSetupChange(activeSetup === "microsoft" ? null : "microsoft")}
        />
      </div>
      <ReadinessCard
        icon={Calendar}
        title="ICS calendar feeds"
        status={readiness.ics}
        action={
          openCalendarSettings
            ? { label: "Open Calendar Settings", onClick: openCalendarSettings }
            : undefined
        }
      />
    </div>
  );
}

function CalendarProviderPanel({
  clientId,
  clientSecret,
  connected,
  isConnecting,
  isOpen,
  isPreview,
  label,
  provider,
  readiness,
  setupNote,
  onOpenSettings,
  onClientIdChange,
  onClientSecretChange,
  onConnect,
  onToggle,
}: {
  clientId: string;
  clientSecret: string;
  connected: boolean;
  isConnecting: boolean;
  isOpen: boolean;
  isPreview: boolean;
  label: string;
  provider: CalendarProvider;
  readiness: ReadinessStatus;
  setupNote: string;
  onOpenSettings?: () => void;
  onClientIdChange: (value: string) => void;
  onClientSecretChange: (value: string) => void;
  onConnect: (provider: CalendarProvider) => void;
  onToggle: () => void;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Calendar size={16} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{label}</h3>
            <p className="mt-1 text-xs text-text-muted">{setupNote}</p>
            <p className="mt-2 text-xs text-text-secondary">{readiness.description}</p>
            {readiness.error && (
              <InlineIssue
                className="mt-2"
                title={readiness.error.title}
                message={readiness.error.message}
                compact
              />
            )}
          </div>
        </div>
        <StatusBadge tone={readiness.tone}>
          {readiness.isLoading && <Loader2 size={11} className="animate-spin" />}
          {readiness.badge}
        </StatusBadge>
      </div>

      {!connected && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              aria-label={`${isOpen ? "Hide" : "Enter"} ${label} credentials`}
              className={`${SECONDARY_BUTTON_CLASS} min-w-[158px]`}
            >
              <Link2 size={14} />
              {isOpen ? "Hide setup" : "Enter credentials"}
            </button>
            {onOpenSettings && (
              <SettingsRepairButton
                label="Open Calendar Settings"
                onClick={onOpenSettings}
              />
            )}
          </div>

          {isOpen && (
            <div className="mt-3 space-y-2">
              <input
                type="text"
                value={clientId}
                onChange={(event) => onClientIdChange(event.target.value)}
                placeholder={provider === "google" ? "Client ID" : "Application (client) ID"}
                className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <input
                type="password"
                value={clientSecret}
                onChange={(event) => onClientSecretChange(event.target.value)}
                placeholder="Client Secret"
                className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={() => onConnect(provider)}
                disabled={isConnecting || !clientId.trim() || !clientSecret.trim()}
                aria-busy={isConnecting}
                className={`${PRIMARY_BUTTON_CLASS} min-w-[112px]`}
              >
                {isConnecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                {isPreview ? "Mark ready" : "Authorize"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StartStep({
  aiProvider,
  configuredCalendarCount,
  hasAnthropicKey,
  micRequested,
}: {
  aiProvider: AiProvider;
  configuredCalendarCount: number;
  hasAnthropicKey: boolean;
  micRequested: boolean;
}) {
  const aiLabel =
    aiProvider === "anthropic"
      ? hasAnthropicKey
        ? "Anthropic ready"
        : "Anthropic selected, key later"
      : aiProvider === "ollama"
        ? "Ollama selected"
        : "Apple Intelligence selected";

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-accent/30 bg-accent/10 p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white">
            <PlayCircle size={18} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Start from the Today view</h3>
            <p className="mt-1 text-sm text-text-secondary">
              Use the Today view to start a recording now. Calendar and AI setup can stay skipped until you need them.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <SummaryItem label="Audio" value={micRequested ? "permission requested" : "ask on first record"} />
        <SummaryItem label="AI" value={aiLabel} />
        <SummaryItem
          label="Calendar"
          value={configuredCalendarCount > 0 ? `${configuredCalendarCount} configured` : "configure later"}
        />
      </div>

      {/* First-five-minutes value (plan v10 #6): don't make the first real
          artifact wait for the first real meeting — any recording the user
          already has works right now. Drops are live even on this screen
          (the app-wide import listener is already mounted). */}
      <ImportTeaser />
    </div>
  );
}

/** "Have a recording already?" affordance on the final onboarding step,
 *  with live status when a drop actually happens mid-onboarding. */
function ImportTeaser() {
  const [importState, setImportState] = useState<{ status: string; title: string } | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ status: string; title: string }>("import-progress", (e) => {
      setImportState(e.payload);
    }).then((fn) => {
      // Unmounting before listen() resolves runs the cleanup below while
      // unlisten is still undefined — drop the registration immediately.
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="rounded-lg border border-dashed border-border bg-bg-tertiary/50 p-4">
      <h3 className="text-sm font-semibold text-text-primary">Have a recording already?</h3>
      <p className="mt-1 text-sm text-text-secondary">
        Drop a Voice Memo or call recording anywhere on this window and it becomes a
        transcribed, searchable meeting, all on this Mac. It&apos;ll be waiting when
        you finish setup.
      </p>
      {importState && (
        <p className="mt-2 text-xs text-accent" role="status">
          {importState.status === "complete"
            ? `✓ Imported “${importState.title}”. It's in your meeting list`
            : `Importing “${importState.title}” (${importState.status})…`}
        </p>
      )}
    </div>
  );
}

function ReadinessCard({
  action,
  icon: Icon,
  status,
  title,
}: {
  action?: {
    label: string;
    onClick: () => void;
  };
  icon: LucideIcon;
  status: ReadinessStatus;
  title: string;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon size={16} />
        </span>
        <StatusBadge tone={status.tone}>
          {status.isLoading && <Loader2 size={11} className="animate-spin" />}
          {status.badge}
        </StatusBadge>
      </div>
      <h3 className="mt-3 text-sm font-semibold text-text-primary">{title}</h3>
      <p className="mt-1 text-sm text-text-secondary">{status.description}</p>
      {status.error && (
        <InlineIssue
          className="mt-3"
          title={status.error.title}
          message={status.error.message}
          compact
        />
      )}
      {action && (
        <div className="mt-3">
          <SettingsRepairButton label={action.label} onClick={action.onClick} />
        </div>
      )}
    </div>
  );
}

function SettingsRepairButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${SECONDARY_BUTTON_CLASS} min-w-[150px] shrink-0`}
    >
      <Settings size={14} />
      {label}
    </button>
  );
}

function InlineReadinessStatus({ status }: { status: ReadinessStatus }) {
  return (
    <div className="mt-3 space-y-1.5">
      <StatusBadge tone={status.tone}>
        {status.isLoading && <Loader2 size={11} className="animate-spin" />}
        {status.badge}
      </StatusBadge>
      <p className="text-xs text-text-secondary">{status.description}</p>
      {status.error && (
        <InlineIssue
          title={status.error.title}
          message={status.error.message}
          compact
        />
      )}
    </div>
  );
}

function InlineIssue({
  className = "",
  compact = false,
  message,
  title,
}: {
  className?: string;
  compact?: boolean;
  message: string;
  title: string;
}) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-lg border border-recording/25 bg-recording/5 text-recording ${
        compact ? "px-2.5 py-2 text-xs" : "px-3 py-2 text-sm"
      } ${className}`}
    >
      <AlertCircle size={compact ? 13 : 15} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block break-words text-text-secondary">{message}</span>
      </span>
    </div>
  );
}

function InfoTile({
  body,
  icon: Icon,
  title,
}: {
  body: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="card p-4">
      <span className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <Icon size={16} />
      </span>
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <p className="mt-1 text-sm text-text-secondary">{body}</p>
    </div>
  );
}

function StatusBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: ReadinessTone;
}) {
  const className =
    tone === "ok"
      ? "bg-accent/10 text-accent"
      : tone === "warn"
        ? "bg-warning/10 text-warning"
        : tone === "error"
          ? "bg-recording/10 text-recording"
          : "bg-bg-hover text-text-muted";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-caption font-medium ${className}`}
    >
      {children}
    </span>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <p className="text-caption font-medium uppercase text-text-muted">{label}</p>
      <p className="mt-1 text-sm font-medium text-text-primary">{value}</p>
    </div>
  );
}

function getResumeStepIndex(progress: OnboardingProgress): number {
  if (progress.resumeStep) {
    const savedStepIndex = ONBOARDING_STEPS.findIndex((step) => step.id === progress.resumeStep);
    if (savedStepIndex >= 0) return savedStepIndex;
  }

  if (progress.viewedCalendarSetup) return stepIndexFor("start");
  if (progress.viewedAiSetup) return stepIndexFor("calendar");
  if (progress.viewedAudioSetup) return stepIndexFor("ai");
  return 0;
}

function stepIndexFor(stepId: StepId): number {
  return ONBOARDING_STEPS.findIndex((step) => step.id === stepId);
}

function getAudioDeviceReadiness(
  devices: string[],
  isLoading: boolean,
  error: unknown,
): ReadinessStatus {
  if (isLoading) {
    return {
      badge: "checking",
      description: "Checking microphone devices available to this Mac.",
      tone: "neutral",
      isLoading: true,
    };
  }

  if (error) {
    return {
      badge: "check failed",
      description: "Could not read microphone devices. Setup can continue and recording will ask again later.",
      tone: "error",
      error: getReadinessError("Device check failed", error),
    };
  }

  if (devices.length > 0) {
    const examples = devices.slice(0, 2).join(", ");
    const suffix = devices.length > 2 ? " and more" : "";
    return {
      badge: `${devices.length} ${devices.length === 1 ? "device" : "devices"} found`,
      description: `Detected ${examples}${suffix}. You can choose a specific device later in Audio settings.`,
      tone: "ok",
    };
  }

  return {
    badge: "no devices",
    description: "No microphone devices were reported. You can skip this step; connect a mic or choose the system default later in Audio settings.",
    tone: "warn",
  };
}

function getWhisperReadiness(
  models: ModelInfo[],
  isLoading: boolean,
  error: unknown,
): ReadinessStatus {
  if (isLoading) {
    return {
      badge: "checking",
      description: "Checking local whisper.cpp model files.",
      tone: "neutral",
      isLoading: true,
    };
  }

  if (error) {
    return {
      badge: "check failed",
      description: "Could not check Whisper models. Setup can continue and models can be downloaded later.",
      tone: "error",
      error: getReadinessError("Model check failed", error),
    };
  }

  const downloaded = models.filter((model) => model.downloaded);
  if (downloaded.length > 0) {
    const modelLabel = downloaded[0]?.label ?? downloaded[0]?.id ?? "Whisper";
    return {
      badge: `${downloaded.length} ${downloaded.length === 1 ? "model" : "models"} ready`,
      description:
        downloaded.length === 1
          ? `${modelLabel} is installed and ready for transcription.`
          : `${downloaded.length} local models are installed and ready for transcription.`,
      tone: "ok",
    };
  }

  return {
    badge: models.length > 0 ? "download needed" : "no models",
    description: "No local Whisper model is installed. You can skip setup and download one later before transcription.",
    tone: "warn",
  };
}

function getAnthropicReadiness(
  hasKey: boolean,
  isLoading: boolean,
  error: unknown,
): ReadinessStatus {
  if (isLoading) {
    return {
      badge: "checking",
      description: "Checking whether a Keychain-backed API key is saved.",
      tone: "neutral",
      isLoading: true,
    };
  }

  if (error) {
    return {
      badge: "check failed",
      description: "Could not check the Anthropic key. You can still add one now or skip AI setup.",
      tone: "error",
      error: getReadinessError("API key check failed", error),
    };
  }

  return hasKey
    ? {
        badge: "key set",
        description: "An Anthropic key is saved in Keychain, so cloud AI notes are ready.",
        tone: "ok",
      }
    : {
        badge: "no key",
        description: "No API key is saved. You can skip AI now and generate notes later after adding a key in AI settings.",
        tone: "warn",
      };
}

function getOllamaReadiness(
  isRunning: boolean | undefined,
  isRunningLoading: boolean,
  runningError: unknown,
  models: string[],
  modelsLoading: boolean,
  modelsError: unknown,
): ReadinessStatus {
  if (isRunningLoading) {
    return {
      badge: "checking",
      description: "Checking whether Ollama is reachable on this Mac.",
      tone: "neutral",
      isLoading: true,
    };
  }

  if (runningError) {
    return {
      badge: "check failed",
      description: "Could not check Ollama. Local AI can be configured later.",
      tone: "error",
      error: getReadinessError("Ollama check failed", runningError),
    };
  }

  if (!isRunning) {
    return {
      badge: "not running",
      description: "Ollama is not running. You can skip local AI now; recording and transcription still work without it.",
      tone: "warn",
    };
  }

  if (modelsLoading) {
    return {
      badge: "checking models",
      description: "Ollama is running; checking installed local models.",
      tone: "neutral",
      isLoading: true,
    };
  }

  if (modelsError) {
    return {
      badge: "model check failed",
      description: "Ollama is running, but models could not be listed. You can retry from AI settings later.",
      tone: "error",
      error: getReadinessError("Ollama model check failed", modelsError),
    };
  }

  if (models.length > 0) {
    return {
      badge: `${models.length} ${models.length === 1 ? "model" : "models"}`,
      description: `${models[0]} is available for local AI notes${models.length > 1 ? " with more models installed" : ""}.`,
      tone: "ok",
    };
  }

  return {
    badge: "no models",
    description: "Ollama is running, but no models are installed. You can skip local AI now and pull a model later.",
    tone: "warn",
  };
}

function getAppleAiReadiness(
  isAvailable: boolean | undefined,
  isLoading: boolean,
  error: unknown,
): ReadinessStatus {
  if (isLoading) {
    return {
      badge: "checking",
      description: "Checking Apple Intelligence availability.",
      tone: "neutral",
      isLoading: true,
    };
  }

  if (error) {
    return {
      badge: "check failed",
      description: "Could not check Apple Intelligence. You can choose another provider or configure this later.",
      tone: "error",
      error: getReadinessError("Apple Intelligence check failed", error),
    };
  }

  return isAvailable
    ? {
        badge: "available",
        description: "Apple Intelligence is available for on-device AI features.",
        tone: "ok",
      }
    : {
        badge: "unavailable",
        description: "Apple Intelligence is unavailable on this Mac right now. Setup can continue.",
        tone: "warn",
      };
}

function getCalendarProviderReadiness({
  label,
  connected,
  credentialsReady,
  connectionLoading,
  credentialsLoading,
  connectionError,
  credentialsError,
}: {
  label: string;
  connected: boolean;
  credentialsReady: boolean;
  connectionLoading: boolean;
  credentialsLoading: boolean;
  connectionError: unknown;
  credentialsError: unknown;
}): ReadinessStatus {
  if (connectionLoading) {
    return {
      badge: "checking",
      description: `Checking ${label} connection state.`,
      tone: "neutral",
      isLoading: true,
    };
  }

  if (connectionError) {
    return {
      badge: "check failed",
      description: `Could not check ${label}. Calendar setup is optional and can be retried later.`,
      tone: "error",
      error: getReadinessError(`${label} connection check failed`, connectionError),
    };
  }

  if (connected) {
    return {
      badge: "connected",
      description: `${label} is connected and can sync meetings.`,
      tone: "ok",
    };
  }

  if (credentialsLoading) {
    return {
      badge: "checking",
      description: `Checking saved ${label} credentials.`,
      tone: "neutral",
      isLoading: true,
    };
  }

  if (credentialsError) {
    return {
      badge: "check failed",
      description: `Could not check ${label} credentials. Calendar setup is optional and can be retried later.`,
      tone: "error",
      error: getReadinessError(`${label} credential check failed`, credentialsError),
    };
  }

  if (credentialsReady) {
    return {
      badge: "credentials saved",
      description: `${label} credentials are saved. Authorize later when you want calendar sync.`,
      tone: "neutral",
    };
  }

  return {
    badge: "not connected",
    description: `${label} is not connected. You can skip calendars now and add credentials later when sync matters.`,
    tone: "neutral",
  };
}

function getIcsReadiness(
  urls: string[],
  isLoading: boolean,
  error: unknown,
): ReadinessStatus {
  if (isLoading) {
    return {
      badge: "checking",
      description: "Checking saved read-only ICS calendar feeds.",
      tone: "neutral",
      isLoading: true,
    };
  }

  if (error) {
    return {
      badge: "check failed",
      description: "Could not check saved ICS feeds. You can still finish setup and add feeds later.",
      tone: "error",
      error: getReadinessError("ICS feed check failed", error),
    };
  }

  if (urls.length > 0) {
    return {
      badge: `${urls.length} ${urls.length === 1 ? "feed" : "feeds"}`,
      description: `${urls.length} read-only ICS ${urls.length === 1 ? "feed is" : "feeds are"} saved for calendar sync.`,
      tone: "ok",
    };
  }

  return {
    badge: "no feeds",
    description: "No ICS feeds are saved. You can skip calendar setup and add a read-only feed later.",
    tone: "neutral",
  };
}

function getReadinessError(title: string, error: unknown): ReadinessStatus["error"] {
  return {
    title,
    message: formatErrorMessage(error),
  };
}

function formatErrorMessage(error: unknown): string {
  if (!error) return "The app did not return additional details.";
  const message = error instanceof Error ? error.message : String(error);
  return message || "The app did not return additional details.";
}
