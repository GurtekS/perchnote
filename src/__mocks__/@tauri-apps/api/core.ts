import { vi } from "vitest";

type InvokeArgs = Record<string, unknown> | undefined;
type CommandHandler = (args: InvokeArgs, state: TauriCoreMockState) => unknown | Promise<unknown>;

interface TauriCoreMockOptions {
  settings?: Record<string, string | null>;
  audioDevices?: string[];
  whisperModels?: MockModelInfo[];
  icsUrls?: string[];
  googleConnected?: boolean;
  microsoftConnected?: boolean;
  ollamaRunning?: boolean;
  appleAiAvailable?: boolean;
  speechEngineAvailable?: boolean;
  commandHandlers?: Record<string, CommandHandler>;
}

interface MockTemplate {
  id: string;
  name: string;
  description: string | null;
  prompt_template: string;
  sections: string;
  is_default: boolean;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

interface MockModelInfo {
  id: string;
  label: string;
  size: string;
  downloaded: boolean;
  path: string | null;
}

interface TauriCoreMockState {
  settings: Map<string, string | null>;
  audioDevices: string[];
  whisperModels: MockModelInfo[];
  icsUrls: Set<string>;
  googleConnected: boolean;
  microsoftConnected: boolean;
  ollamaRunning: boolean;
  appleAiAvailable: boolean;
  speechEngineAvailable: boolean;
  recordingMeetingId: string | null;
  isPaused: boolean;
  templates: MockTemplate[];
  commandHandlers: Record<string, CommandHandler>;
}

const now = "2026-05-22T00:00:00.000Z";

function makeDefaultTemplate(): MockTemplate {
  return {
    id: "template-default",
    name: "Standard meeting notes",
    description: "Default structured meeting-note template",
    prompt_template: "Summarize this meeting.",
    sections: "[]",
    is_default: true,
    is_builtin: true,
    created_at: now,
    updated_at: now,
  };
}

function createState(options: TauriCoreMockOptions = {}): TauriCoreMockState {
  return {
    settings: new Map(Object.entries(options.settings ?? {})),
    audioDevices: options.audioDevices ?? ["System Default", "Built-in Microphone"],
    whisperModels: options.whisperModels ?? [
      {
        id: "medium.en",
        label: "Medium English",
        size: "1.5 GB",
        downloaded: true,
        path: "/mock/models/medium.en.bin",
      },
    ],
    icsUrls: new Set(options.icsUrls ?? []),
    googleConnected: options.googleConnected ?? false,
    microsoftConnected: options.microsoftConnected ?? false,
    ollamaRunning: options.ollamaRunning ?? false,
    appleAiAvailable: options.appleAiAvailable ?? false,
    speechEngineAvailable: options.speechEngineAvailable ?? false,
    recordingMeetingId: null,
    isPaused: false,
    templates: [makeDefaultTemplate()],
    commandHandlers: options.commandHandlers ?? {},
  };
}

let state = createState();

function stringArg(args: InvokeArgs, key: string): string {
  const value = args?.[key];
  return typeof value === "string" ? value : "";
}

function nullableStringArg(args: InvokeArgs, key: string): string | null {
  const value = args?.[key];
  return typeof value === "string" ? value : null;
}

async function defaultInvoke(command: string, args?: InvokeArgs): Promise<unknown> {
  const handler = state.commandHandlers[command];
  if (handler) return handler(args, state);

  switch (command) {
    case "get_setting":
      return state.settings.get(stringArg(args, "key")) ?? null;
    case "set_setting":
      state.settings.set(stringArg(args, "key"), nullableStringArg(args, "value"));
      return null;

    case "list_audio_devices":
      return state.audioDevices;
    case "list_whisper_models":
      return state.whisperModels;
    case "download_whisper_model":
      return "/mock/models/downloaded.bin";
    case "list_voice_profiles":
      return [];
    case "save_voice_profile":
      return {
        id: "voice-profile-1",
        speaker_name: stringArg(args, "name") || "Test speaker",
        sample_path: "/mock/voice-profile.wav",
        created_at: now,
      };
    case "delete_voice_profile":
      return null;

    case "is_ollama_running":
      return state.ollamaRunning;
    case "list_ollama_models":
      return state.ollamaRunning ? ["llama3.2"] : [];
    case "is_apple_ai_available":
      return state.appleAiAvailable;
    case "speech_engine_available":
      return state.speechEngineAvailable;
    case "list_anthropic_models":
      return [
        {
          id: "claude-sonnet-4-6",
          display_name: "Claude Sonnet 4.6",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ];

    case "is_calendar_connected":
      return state.googleConnected;
    case "is_microsoft_connected":
      return state.microsoftConnected;
    case "has_calendar_credentials":
      return !!state.settings.get("google_client_id") && !!state.settings.get("google_client_secret");
    case "has_microsoft_credentials":
      return !!state.settings.get("microsoft_client_id") && !!state.settings.get("microsoft_client_secret");
    case "start_google_oauth":
      state.googleConnected = true;
      return "";
    case "start_microsoft_oauth":
      state.microsoftConnected = true;
      return "";
    case "disconnect_calendar":
      state.googleConnected = false;
      return null;
    case "disconnect_microsoft":
      state.microsoftConnected = false;
      return null;
    case "add_ics_url":
      state.icsUrls.add(stringArg(args, "url"));
      return null;
    case "remove_ics_url":
      state.icsUrls.delete(stringArg(args, "url"));
      return null;
    case "list_ics_urls":
      return Array.from(state.icsUrls);
    case "sync_ics_calendars":
    case "sync_calendar":
    case "sync_microsoft_calendar":
      return state.icsUrls.size;
    case "auto_create_from_calendar":
      return 0;

    case "start_recording":
      state.recordingMeetingId = stringArg(args, "meetingId") || "mock-meeting";
      state.isPaused = false;
      return null;
    case "stop_recording": {
      const meetingId = state.recordingMeetingId ?? "mock-meeting";
      state.recordingMeetingId = null;
      state.isPaused = false;
      return `${meetingId}.wav`;
    }
    case "pause_recording":
      state.isPaused = true;
      return null;
    case "resume_recording":
      state.isPaused = false;
      return null;
    case "is_paused":
      return state.isPaused;
    case "is_recording":
      return state.recordingMeetingId !== null;
    case "get_recording_meeting_id":
      return state.recordingMeetingId;

    case "list_templates":
      return state.templates;
    case "create_template": {
      const template: MockTemplate = {
        id: `template-${state.templates.length + 1}`,
        name: stringArg(args, "name") || "Untitled template",
        description: nullableStringArg(args, "description"),
        prompt_template: stringArg(args, "promptTemplate"),
        sections: stringArg(args, "sections") || "[]",
        is_default: Boolean(args?.isDefault),
        is_builtin: false,
        created_at: now,
        updated_at: now,
      };
      state.templates.push(template);
      return template;
    }
    case "update_template":
      state.templates = state.templates.map((template) =>
        template.id === stringArg(args, "id")
          ? {
              ...template,
              name: stringArg(args, "name") || template.name,
              description: nullableStringArg(args, "description"),
              prompt_template: stringArg(args, "promptTemplate"),
              sections: stringArg(args, "sections") || template.sections,
              is_default: Boolean(args?.isDefault),
              updated_at: now,
            }
          : template,
      );
      return null;
    case "delete_template":
      state.templates = state.templates.filter((template) => template.id !== stringArg(args, "id"));
      return null;

    case "get_storage_stats":
      return {
        total_meetings: 0,
        total_transcripts: 0,
        total_notes: 0,
        total_chat_messages: 0,
        db_size_bytes: 0,
      };
    case "get_app_paths":
      return {
        data_dir: "/mock/perchnote",
        recordings_dir: "/mock/perchnote/recordings",
        models_dir: "/mock/perchnote/models",
        db_path: "/mock/perchnote/perchnote.sqlite",
      };
    case "list_deleted_meetings":
      return [];
    case "delete_meeting":
    case "restore_meeting":
    case "reveal_in_finder":
    case "open_url":
    case "write_clipboard":
      return null;
    case "export_all_data":
      return "{}";

    case "list_meetings":
      return [];
    case "create_meeting":
      return {
        id: "mock-meeting",
        title: stringArg(args, "title") || "Mock meeting",
        scheduled_start: null,
        scheduled_end: null,
        actual_start: null,
        actual_end: null,
        calendar_event_id: null,
        attendees: "[]",
        location: null,
        meeting_url: null,
        platform: "manual",
        status: "scheduled",
        is_pinned: false,
        is_archived: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        device_name: null,
        system_audio_captured: false,
        note_status: "none",
      };

    case "get_folder_memberships_map":
      return {};

    default:
      return null;
  }
}

export const invoke = vi.fn(defaultInvoke);
export const convertFileSrc = vi.fn((path: string) => path);

export function resetTauriCoreMock(options: TauriCoreMockOptions = {}) {
  state = createState(options);
  invoke.mockReset();
  invoke.mockImplementation(defaultInvoke);
  convertFileSrc.mockReset();
  convertFileSrc.mockImplementation((path: string) => path);
}
