import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OnboardingFlow,
  type OnboardingFlowMode,
  type OnboardingRepairSection,
} from "../../components/settings/OnboardingFlow";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

vi.mock("../../stores/toastStore", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    action: vi.fn(),
  },
}));

const mockInvoke = vi.mocked(invoke);

function renderFlow({
  mode = "first-run",
  onComplete = vi.fn(),
  onOpenSettingsSection,
}: {
  mode?: OnboardingFlowMode;
  onComplete?: () => void | Promise<void>;
  onOpenSettingsSection?: (section: OnboardingRepairSection) => void;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();

  render(
    <QueryClientProvider client={queryClient}>
      <OnboardingFlow
        mode={mode}
        onComplete={onComplete}
        onOpenSettingsSection={onOpenSettingsSection}
      />
    </QueryClientProvider>,
  );

  return { onComplete, queryClient, user };
}

async function advanceToFinalStep(user: ReturnType<typeof userEvent.setup>) {
  await goForward(user);
  await goForward(user);
  await goForward(user);
  await goForward(user);
  await goForward(user);
}

async function goForward(user: ReturnType<typeof userEvent.setup>) {
  const nextActions = screen.getAllByRole("button", {
    name: /Check audio|Skip audio setup|Review AI options|Skip AI setup|Review calendar options|Skip calendar setup|Test your setup|Review start steps/i,
  });
  await user.click(nextActions[nextActions.length - 1]);
}

function commandCalls(command: string) {
  return mockInvoke.mock.calls.filter(([calledCommand]) => calledCommand === command);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe("OnboardingFlow", () => {
  beforeEach(() => {
    resetTauriCoreMock();
  });

  it("navigates between onboarding steps with footer and sidebar controls", async () => {
    const { user } = renderFlow();

    expect(screen.getByRole("heading", { name: "Local-first meeting capture" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    await goForward(user);

    expect(screen.getByRole("heading", { name: "Check audio readiness" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByRole("heading", { name: "Local-first meeting capture" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /CalendarOptional calendar connection/i }),
    );

    expect(screen.getByRole("heading", { name: "Optional calendar connection" })).toBeInTheDocument();
  });

  it("shows microphone device and Whisper model readiness from IPC", async () => {
    resetTauriCoreMock({
      audioDevices: ["Studio Mic", "Webcam Mic"],
      whisperModels: [
        {
          id: "base.en",
          label: "Base English",
          size: "148 MB",
          downloaded: true,
          path: "/mock/models/base.en.bin",
        },
        {
          id: "medium.en",
          label: "Medium English",
          size: "1.5 GB",
          downloaded: false,
          path: null,
        },
      ],
    });
    const { user } = renderFlow();

    await goForward(user);

    expect(await screen.findByText("2 devices found")).toBeInTheDocument();
    expect(screen.getByText(/Detected Studio Mic, Webcam Mic/)).toBeInTheDocument();
    expect(screen.getByText("1 model ready")).toBeInTheDocument();
    expect(screen.getByText("Base English is installed and ready for transcription.")).toBeInTheDocument();
  });

  it("renders loading readiness states while production checks are pending", async () => {
    const audioDevices = deferred<string[]>();
    const whisperModels = deferred<unknown[]>();
    const anthropicKey = deferred<string | null>();
    const ollamaRunning = deferred<boolean>();
    const appleAiAvailable = deferred<boolean>();
    const googleConnected = deferred<boolean>();
    const microsoftConnected = deferred<boolean>();
    const icsUrls = deferred<string[]>();

    resetTauriCoreMock({
      commandHandlers: {
        list_audio_devices: () => audioDevices.promise,
        list_whisper_models: () => whisperModels.promise,
        get_setting: (args, state) => {
          if (args?.key === "anthropic_api_key") {
            return anthropicKey.promise;
          }

          return state.settings.get(String(args?.key)) ?? null;
        },
        is_ollama_running: () => ollamaRunning.promise,
        is_apple_ai_available: () => appleAiAvailable.promise,
        is_calendar_connected: () => googleConnected.promise,
        is_microsoft_connected: () => microsoftConnected.promise,
        list_ics_urls: () => icsUrls.promise,
      },
    });
    const { queryClient, user } = renderFlow();

    await goForward(user);

    expect(await screen.findByText("Checking microphone devices available to this Mac.")).toBeInTheDocument();
    expect(screen.getByText("Checking local whisper.cpp model files.")).toBeInTheDocument();

    await goForward(user);

    expect(await screen.findByText("Checking whether a Keychain-backed API key is saved.")).toBeInTheDocument();
    expect(screen.getByText("Checking whether Ollama is reachable on this Mac.")).toBeInTheDocument();
    expect(screen.getByText("Checking Apple Intelligence availability.")).toBeInTheDocument();

    await goForward(user);

    expect(await screen.findByText("Checking Google Calendar connection state.")).toBeInTheDocument();
    expect(screen.getByText("Checking Microsoft Calendar connection state.")).toBeInTheDocument();
    expect(screen.getByText("Checking saved read-only ICS calendar feeds.")).toBeInTheDocument();

    audioDevices.resolve([]);
    whisperModels.resolve([]);
    anthropicKey.resolve(null);
    ollamaRunning.resolve(false);
    appleAiAvailable.resolve(false);
    googleConnected.resolve(false);
    microsoftConnected.resolve(false);
    icsUrls.resolve([]);
    queryClient.clear();
  });

  it("explains missing device, model, AI key, Ollama model, and calendar states as skippable", async () => {
    resetTauriCoreMock({
      audioDevices: [],
      whisperModels: [],
      ollamaRunning: true,
      appleAiAvailable: false,
      commandHandlers: {
        list_ollama_models: () => [],
      },
    });
    const { user } = renderFlow();

    await goForward(user);

    expect(await screen.findByText("no devices")).toBeInTheDocument();
    expect(screen.getByText(/connect a mic or choose the system default later/)).toBeInTheDocument();
    expect(screen.getByText("No local Whisper model is installed. You can skip setup and download one later before transcription.")).toBeInTheDocument();

    await goForward(user);

    expect(await screen.findByText("no key")).toBeInTheDocument();
    expect(screen.getByText(/No API key is saved/)).toBeInTheDocument();
    expect(screen.getByText("Ollama is running, but no models are installed. You can skip local AI now and pull a model later.")).toBeInTheDocument();
    expect(screen.getByText("Apple Intelligence is unavailable on this Mac right now. Setup can continue.")).toBeInTheDocument();

    await goForward(user);

    expect(await screen.findAllByText("not connected")).toHaveLength(2);
    expect(screen.getByText("No ICS feeds are saved. You can skip calendar setup and add a read-only feed later.")).toBeInTheDocument();
    expect(screen.getByText(/No calendar is required/)).toBeInTheDocument();
  });

  it("shows AI provider readiness without exposing saved secret values", async () => {
    resetTauriCoreMock({
      settings: {
        ai_provider: "ollama",
        anthropic_api_key: "stored-key-present",
      },
      ollamaRunning: true,
      appleAiAvailable: true,
    });
    const { user } = renderFlow();

    await goForward(user);
    await goForward(user);

    expect((await screen.findAllByText("key set")).length).toBeGreaterThan(0);
    expect(screen.getByText("1 model")).toBeInTheDocument();
    expect(screen.getByText("available")).toBeInTheDocument();
    expect(screen.queryByText("stored-key-present")).not.toBeInTheDocument();
  });

  it("shows Google, Microsoft, and ICS calendar readiness without requiring connections", async () => {
    resetTauriCoreMock({
      googleConnected: true,
      icsUrls: ["https://example.com/team.ics"],
      settings: {
        microsoft_client_id: "microsoft-client-id",
        microsoft_client_secret: "present",
      },
    });
    const { user } = renderFlow();

    await goForward(user);
    await goForward(user);
    await goForward(user);

    expect(await screen.findByText("2 configured")).toBeInTheDocument();
    expect(screen.getByText("Google Calendar is connected and can sync meetings.")).toBeInTheDocument();
    expect(screen.getByText("Microsoft Calendar credentials are saved. Authorize later when you want calendar sync.")).toBeInTheDocument();
    expect(screen.getByText("1 read-only ICS feed is saved for calendar sync.")).toBeInTheDocument();
  });

  it("keeps missing or unavailable readiness states non-blocking", async () => {
    resetTauriCoreMock({
      audioDevices: [],
      whisperModels: [
        {
          id: "medium.en",
          label: "Medium English",
          size: "1.5 GB",
          downloaded: false,
          path: null,
        },
      ],
      ollamaRunning: false,
      appleAiAvailable: false,
      commandHandlers: {
        is_calendar_connected: () => {
          throw new Error("offline");
        },
      },
    });
    const onComplete = vi.fn();
    const { user } = renderFlow({ onComplete });

    await goForward(user);

    expect(await screen.findByText("no devices")).toBeInTheDocument();
    expect(screen.getByText(/You can skip this step; connect a mic/)).toBeInTheDocument();
    expect(screen.getByText("download needed")).toBeInTheDocument();
    expect(screen.getByText(/download one later before transcription/)).toBeInTheDocument();

    await goForward(user);

    expect(await screen.findByText("not running")).toBeInTheDocument();
    expect(screen.getByText(/skip local AI now/)).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();

    await goForward(user);

    expect(await screen.findByText("check failed")).toBeInTheDocument();
    expect(screen.getByText("none connected")).toBeInTheDocument();
    expect(screen.getByText(/No calendar is required/)).toBeInTheDocument();

    await goForward(user);
    await goForward(user);
    await user.click(screen.getByRole("button", { name: /Start using Perchnote/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  it("lets users skip optional setup and complete the real first-run flow", async () => {
    const onComplete = vi.fn();
    const { user } = renderFlow({ onComplete });

    await advanceToFinalStep(user);

    expect(screen.getByText("ask on first record")).toBeInTheDocument();
    expect(screen.getByText("Anthropic selected, key later")).toBeInTheDocument();
    expect(screen.getByText("configure later")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Start using Perchnote/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  it("renders readiness IPC failures as inline errors while keeping setup skippable", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_audio_devices: () => {
          throw new Error("audio service unavailable");
        },
        list_whisper_models: () => {
          throw new Error("model directory unavailable");
        },
        get_setting: (args, state) => {
          if (args?.key === "anthropic_api_key") {
            throw new Error("keychain locked");
          }
          return state.settings.get(String(args?.key)) ?? null;
        },
        is_ollama_running: () => {
          throw new Error("ollama socket unavailable");
        },
        is_apple_ai_available: () => {
          throw new Error("apple check unavailable");
        },
        is_calendar_connected: () => {
          throw new Error("google check offline");
        },
        list_ics_urls: () => {
          throw new Error("ics store unavailable");
        },
      },
    });
    const onComplete = vi.fn();
    const { user } = renderFlow({ onComplete });

    await goForward(user);

    expect(await screen.findByText("Device check failed")).toBeInTheDocument();
    expect(screen.getByText("audio service unavailable")).toBeInTheDocument();
    expect(screen.getByText("Model check failed")).toBeInTheDocument();
    expect(screen.getByText("model directory unavailable")).toBeInTheDocument();

    await goForward(user);

    expect(await screen.findByText("API key check failed")).toBeInTheDocument();
    expect(screen.getByText("keychain locked")).toBeInTheDocument();
    expect(screen.getByText("Ollama check failed")).toBeInTheDocument();
    expect(screen.getByText("ollama socket unavailable")).toBeInTheDocument();
    expect(screen.getByText("Apple Intelligence check failed")).toBeInTheDocument();
    expect(screen.getByText("apple check unavailable")).toBeInTheDocument();

    await goForward(user);

    expect(await screen.findByText("Google Calendar connection check failed")).toBeInTheDocument();
    expect(screen.getByText("google check offline")).toBeInTheDocument();
    expect(screen.getByText("ICS feed check failed")).toBeInTheDocument();
    expect(screen.getByText("ics store unavailable")).toBeInTheDocument();

    await goForward(user);
    await goForward(user);
    await user.click(screen.getByRole("button", { name: /Start using Perchnote/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps preview setup and completion from writing persistent settings", async () => {
    const onComplete = vi.fn();
    const { user } = renderFlow({ mode: "preview", onComplete });

    await goForward(user);
    await user.click(screen.getByRole("button", { name: "Request microphone access" }));

    expect(await screen.findByRole("button", { name: "Permission check requested" })).toBeDisabled();

    await goForward(user);
    await user.type(screen.getByPlaceholderText("sk-ant-…"), "sk-ant-");
    await user.click(screen.getByRole("button", { name: "Use for preview" }));

    expect((await screen.findAllByText("key set")).length).toBeGreaterThan(0);

    await goForward(user);
    await user.click(screen.getByRole("button", { name: "Enter Google Calendar credentials" }));
    await user.type(screen.getByPlaceholderText("Client ID"), "google-client-id");
    await user.type(screen.getByPlaceholderText("Client Secret"), "present");
    await user.click(screen.getByRole("button", { name: "Mark ready" }));

    expect(await screen.findByText("1 configured")).toBeInTheDocument();

    await goForward(user);
    await goForward(user);

    expect(screen.getByText("permission requested")).toBeInTheDocument();
    expect(screen.getByText("Anthropic ready")).toBeInTheDocument();
    expect(screen.getByText("1 configured")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Return to Today/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    expect(commandCalls("set_setting")).toHaveLength(0);
    expect(commandCalls("start_recording")).toHaveLength(0);
    expect(commandCalls("stop_recording")).toHaveLength(0);
    expect(commandCalls("start_google_oauth")).toHaveLength(0);
  });

  it("keeps replay mode on the first step even when saved progress points later", async () => {
    resetTauriCoreMock({
      settings: {
        onboarding_viewed_audio_setup: "true",
        onboarding_viewed_ai_setup: "true",
        onboarding_resume_step: "calendar",
      },
    });
    renderFlow({ mode: "preview" });

    expect(screen.getByRole("heading", { name: "Local-first meeting capture" })).toBeInTheDocument();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_setting", {
        key: "onboarding_resume_step",
      });
    });
    expect(screen.getByRole("heading", { name: "Local-first meeting capture" })).toBeInTheDocument();
    expect(commandCalls("set_setting")).toHaveLength(0);
  });

  it("offers preview repair links to the related settings sections without writing progress", async () => {
    const onOpenSettingsSection = vi.fn();
    const { user } = renderFlow({ mode: "preview", onOpenSettingsSection });

    await goForward(user);
    await user.click((await screen.findAllByRole("button", { name: "Open Audio Settings" }))[0]);

    await goForward(user);
    await user.click(screen.getByRole("button", { name: "Open AI Settings" }));

    await goForward(user);
    await user.click((await screen.findAllByRole("button", { name: "Open Calendar Settings" }))[0]);

    expect(onOpenSettingsSection).toHaveBeenNthCalledWith(1, "audio");
    expect(onOpenSettingsSection).toHaveBeenNthCalledWith(2, "ai");
    expect(onOpenSettingsSection).toHaveBeenNthCalledWith(3, "calendar");
    expect(commandCalls("set_setting")).toHaveLength(0);
  });

  it("resumes first-run setup from persisted safe local progress", async () => {
    resetTauriCoreMock({
      settings: {
        onboarding_viewed_audio_setup: "true",
        onboarding_resume_step: "ai",
      },
    });
    renderFlow();

    expect(await screen.findByRole("heading", { name: "Choose how notes are generated" })).toBeInTheDocument();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
        key: "onboarding_resume_step",
        value: "ai",
      });
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
      key: "onboarding_viewed_ai_setup",
      value: "true",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("set_setting", {
      key: "onboarding_resume_step",
      value: "privacy",
    });
  });

  it("persists audio progress before probing microphone permission without completing onboarding", async () => {
    const { user } = renderFlow();

    await goForward(user);
    await user.click(screen.getByRole("button", { name: "Request microphone access" }));

    expect(await screen.findByRole("button", { name: "Permission check requested" })).toBeDisabled();

    const calls = mockInvoke.mock.calls;
    const resumeWriteIndex = calls.findIndex(
      ([command, args]) =>
        command === "set_setting" &&
        args?.key === "onboarding_resume_step" &&
        args?.value === "audio",
    );
    const audioMilestoneWriteIndex = calls.findIndex(
      ([command, args]) =>
        command === "set_setting" &&
        args?.key === "onboarding_viewed_audio_setup" &&
        args?.value === "true",
    );
    const completionWriteIndex = calls.findIndex(
      ([command, args]) =>
        command === "set_setting" &&
        args?.key === "onboarding_completed",
    );
    const startRecordingIndex = calls.findIndex(([command]) => command === "start_recording");
    const stopRecordingIndex = calls.findIndex(([command]) => command === "stop_recording");

    expect(resumeWriteIndex).toBeGreaterThanOrEqual(0);
    expect(audioMilestoneWriteIndex).toBeGreaterThanOrEqual(0);
    expect(completionWriteIndex).toBe(-1);
    expect(startRecordingIndex).toBeGreaterThan(Math.max(resumeWriteIndex, audioMilestoneWriteIndex));
    expect(stopRecordingIndex).toBeGreaterThan(startRecordingIndex);
    expect(mockInvoke).toHaveBeenCalledWith("start_recording", {
      meetingId: "permission-check",
      deviceName: null,
      // mic-only probe: the Screen Recording gate must not block the mic
      // permission check.
      systemAudio: false,
    });
  });
});
