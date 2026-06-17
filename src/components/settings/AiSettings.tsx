import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  ExternalLink,
  Cloud,
  HardDrive,
  Loader2,
  Sparkles,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toUserMessage } from "../../lib/errors";
import { toast } from "../../stores/toastStore";
import {
  InlineSettingsStatus,
  SettingsSectionHeader,
  SettingsStatusBadge,
  SettingsSubsectionHeader,
  primarySettingsButtonClass,
  secondarySettingsButtonClass,
  settingsInputClass,
} from "./settingsUi";

// ─── Constants ───────────────────────────────────────────────────────────────

const PROVIDER_SETTING = "ai_provider";
const ANTHROPIC_KEY_SETTING = "anthropic_api_key";
const ANTHROPIC_MODEL_SETTING = "anthropic_model";
const OLLAMA_MODEL_SETTING = "ollama_model";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OLLAMA_MODEL = "llama3.2";

type ProviderId = "anthropic" | "ollama" | "apple";

interface AnthropicModel {
  id: string;
  display_name: string;
  created_at: string;
}

/// Categorize a model by its tier hint so we can show a one-line
/// description without maintaining a per-model table. Pattern-matches on
/// the canonical "claude-{tier}-X-Y" id format Anthropic uses.
function tierHint(id: string): string {
  if (id.includes("opus"))   return "Highest quality. Best for complex meetings.";
  if (id.includes("sonnet")) return "Balanced default. Strong quality, fast.";
  if (id.includes("haiku"))  return "Fastest. Lower quality for long transcripts.";
  return "Claude model.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AiSettings() {
  const qc = useQueryClient();

  const { data: storedProvider } = useQuery({
    queryKey: ["setting", PROVIDER_SETTING],
    queryFn: () => ipc.getSetting(PROVIDER_SETTING),
  });
  const provider: ProviderId = ((storedProvider as ProviderId) || "anthropic");

  const pickProvider = async (id: ProviderId) => {
    try {
      await ipc.setSetting(PROVIDER_SETTING, id);
      qc.invalidateQueries({ queryKey: ["setting", PROVIDER_SETTING] });
    } catch (e) {
      toast.error(toUserMessage(e, "Couldn't switch the AI provider"));
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSectionHeader
        title="AI"
        description="Pick where note generation, chat, and speaker detection run. Recording, transcription, and search continue to work without an AI provider."
        badge={<SettingsStatusBadge tone={provider === "anthropic" ? "neutral" : "ok"}>{provider}</SettingsStatusBadge>}
      />

      {/* Provider radio */}
      <section className="space-y-1.5">
        <ProviderCard
          id="anthropic"
          icon={<Cloud size={14} />}
          label="Anthropic API"
          tagline="Cloud Claude (Opus / Sonnet / Haiku). Best quality."
          selected={provider === "anthropic"}
          onSelect={() => pickProvider("anthropic")}
          status={<AnthropicStatus />}
        />
        <ProviderCard
          id="ollama"
          icon={<HardDrive size={14} />}
          label="Ollama (local)"
          tagline="Runs locally. Free. Requires Ollama installed on this machine."
          selected={provider === "ollama"}
          onSelect={() => pickProvider("ollama")}
          status={<OllamaStatus />}
        />
        <ProviderCard
          id="apple"
          icon={<Sparkles size={14} />}
          label="Apple Intelligence"
          tagline="On-device Apple model. Free. macOS 26+ with Apple Intelligence enabled."
          selected={provider === "apple"}
          onSelect={() => pickProvider("apple")}
          status={<AppleStatus />}
        />
      </section>

      {/* Per-provider config */}
      {provider === "anthropic" && <AnthropicConfig />}
      {provider === "ollama"    && <OllamaConfig />}
      {provider === "apple"     && <AppleConfig />}

      {/* How notes get generated — provider-independent behavior (moved
          here from General, where it was a junk-drawer surprise). */}
      <GenerationSection />

      {/* Semantic recall backend (plan v10 #4) — independent of the
          note-generation provider above. */}
      <SemanticRecallSection />
    </div>
  );
}

// ─── Generation behavior ─────────────────────────────────────────────────────

function GenerationSection() {
  const queryClient = useQueryClient();
  const contextDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: autoEnhance = "" } = useQuery({
    queryKey: ["setting", "auto_enhance_on_complete"],
    queryFn: () => ipc.getSetting("auto_enhance_on_complete").then((v) => v ?? ""),
  });

  const handleAutoEnhanceChange = async (on: boolean) => {
    await ipc.setSetting("auto_enhance_on_complete", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "auto_enhance_on_complete"] });
    toast.success(on ? "Instant recap on" : "Instant recap off");
  };

  const { data: autoTitle = "" } = useQuery({
    queryKey: ["setting", "auto_title_on_complete"],
    queryFn: () => ipc.getSetting("auto_title_on_complete").then((v) => v ?? ""),
  });
  const handleAutoTitleChange = async (on: boolean) => {
    await ipc.setSetting("auto_title_on_complete", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "auto_title_on_complete"] });
    toast.success(on ? "Auto-naming on" : "Auto-naming off");
  };

  const { data: ownTasksOnly = "" } = useQuery({
    queryKey: ["setting", "tasks_own_only"],
    queryFn: () => ipc.getSetting("tasks_own_only").then((v) => v ?? ""),
  });
  const handleOwnTasksChange = async (on: boolean) => {
    await ipc.setSetting("tasks_own_only", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "tasks_own_only"] });
  };

  const { data: savedUserContext = "" } = useQuery({
    queryKey: ["setting", "user_context"],
    queryFn: () => ipc.getSetting("user_context").then((v) => v ?? ""),
  });

  const { data: contextAuto = "" } = useQuery({
    queryKey: ["setting", "user_context_auto"],
    queryFn: () => ipc.getSetting("user_context_auto").then((v) => v ?? ""),
  });
  const [generatingContext, setGeneratingContext] = useState(false);

  const handleUserContextChange = (value: string) => {
    if (contextDebounceRef.current) clearTimeout(contextDebounceRef.current);
    contextDebounceRef.current = setTimeout(async () => {
      await ipc.setSetting("user_context", value);
      // A hand edit takes ownership: stop the weekly auto-refresh from
      // overwriting what the user wrote.
      await ipc.setSetting("user_context_auto", "false");
      queryClient.invalidateQueries({ queryKey: ["setting", "user_context"] });
      queryClient.invalidateQueries({ queryKey: ["setting", "user_context_auto"] });
    }, 600);
  };

  const generateContextFromMeetings = async () => {
    setGeneratingContext(true);
    try {
      const text = await ipc.generateUserContext();
      // Flags before text — mirrors the backend ordering so an interrupted
      // sequence re-generates next launch instead of freezing a half-state.
      await ipc.setSetting("user_context_auto", "true");
      await ipc.setSetting("user_context_generated_at", new Date().toISOString());
      await ipc.setSetting("user_context", text);
      queryClient.invalidateQueries({ queryKey: ["setting", "user_context"] });
      queryClient.invalidateQueries({ queryKey: ["setting", "user_context_auto"] });
      toast.success("About You generated from your meetings");
    } catch (e) {
      toast.error(toUserMessage(e));
    } finally {
      setGeneratingContext(false);
    }
  };

  return (
    <section className="space-y-5 border-t border-border pt-5">
      <SettingsSubsectionHeader
        title="Generation"
        description="How AI notes get written — applies whichever provider runs them."
      />

      {/* Instant recap */}
      <div>
        <h4 className="text-sm font-medium text-text-primary mb-1">Instant recap</h4>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={autoEnhance !== "false"}
            onChange={(e) => handleAutoEnhanceChange(e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span className="text-xs text-text-muted">
            Enhance notes automatically when a recording finishes, so the
            summary and action items are waiting without a click. Uses your
            configured AI provider.
          </span>
        </label>
      </div>

      {/* Auto-naming */}
      <div>
        <h4 className="text-sm font-medium text-text-primary mb-1">Auto-naming</h4>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={autoTitle !== "false"}
            onChange={(e) => handleAutoTitleChange(e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span className="text-xs text-text-muted">
            Name untitled meetings from their transcript when a recording
            finishes. Only placeholder titles like "Untitled Meeting" are
            swapped — titles you typed are never touched, and there's an
            Undo on the spot.
          </span>
        </label>
      </div>

      {/* Whose tasks */}
      <div>
        <h4 className="text-sm font-medium text-text-primary mb-1">My Tasks Only</h4>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={ownTasksOnly !== "false"}
            onChange={(e) => handleOwnTasksChange(e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span className="text-xs text-text-muted">
            AI notes extract action items only for you — the person recording.
            What others agreed to do stays in the summary, not your task list.
          </span>
        </label>
      </div>

      {/* About You */}
      <div>
        <h4 className="text-sm font-medium text-text-primary mb-1">About You</h4>
        <p className="text-xs text-text-muted mb-3">
          Add context about your role to improve AI note quality. For example: "Product manager at a B2B SaaS startup focused on enterprise deals."
        </p>
        <textarea
          key={savedUserContext}
          defaultValue={savedUserContext}
          onChange={(e) => handleUserContextChange(e.target.value)}
          placeholder="E.g. Senior engineer at Acme Corp, working on the payments team…"
          rows={3}
          aria-label="About You"
          className="w-full bg-bg-tertiary text-text-primary text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent resize-none placeholder:text-text-muted/50"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={generateContextFromMeetings}
            disabled={generatingContext}
            title="Builds this from the titles, attendees, and AI notes of your recent meetings"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-text-secondary border border-border hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          >
            {generatingContext ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Generate from my meetings
          </button>
          <span className="text-caption text-text-muted">
            {contextAuto === "true"
              ? "Auto-generated from your meetings; refreshes weekly. Editing it takes ownership."
              : "Also fills itself in automatically once a few meetings have AI notes."}
          </span>
        </div>
      </div>
    </section>
  );
}

// ─── Semantic recall ─────────────────────────────────────────────────────────

const EMBEDDING_BACKEND_SETTING = "embedding_backend";

interface EmbeddingStatus {
  backend: "apple" | "ollama" | "off";
  model: string | null;
  setting: string;
  apple_available: boolean;
  apple_assets_installed: boolean;
}

function SemanticRecallSection() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["embedding-status"],
    queryFn: () => invoke<EmbeddingStatus | null>("embedding_status"),
    retry: false,
  });

  const pick = async (value: string) => {
    try {
      // "" = automatic (the backend treats unset/empty as auto-detect).
      await ipc.setSetting(EMBEDDING_BACKEND_SETTING, value === "auto" ? "" : value);
      qc.invalidateQueries({ queryKey: ["embedding-status"] });
    } catch (e) {
      toast.error(toUserMessage(e, "Couldn't switch semantic recall"));
    }
  };

  const downloading =
    status?.backend === "off" &&
    status.setting !== "off" &&
    status.apple_available &&
    !status.apple_assets_installed;
  const label = !status
    ? "checking"
    : status.backend === "apple"
      ? "On — Apple on-device"
      : status.backend === "ollama"
        ? `On — Ollama (${status.model ?? "?"})`
        : downloading
          ? "Off — downloading Apple model"
          : "Off";

  return (
    <section className="border-t border-border pt-5">
      <SettingsSubsectionHeader
        title="Semantic Recall"
        description="Lets search and chat find meetings by meaning, not just keywords. Runs fully on-device; when off, search is keyword-only."
        action={
          <SettingsStatusBadge tone={!status || status.backend === "off" ? "neutral" : "ok"}>
            {label}
          </SettingsStatusBadge>
        }
      />
      <select
        value={status?.setting ?? "auto"}
        onChange={(e) => pick(e.target.value)}
        className={settingsInputClass}
        aria-label="Semantic recall backend"
      >
        <option value="auto">Automatic (recommended)</option>
        <option value="apple">Apple on-device</option>
        <option value="ollama">Ollama</option>
        <option value="off">Off</option>
      </select>
    </section>
  );
}

// ─── Provider card ───────────────────────────────────────────────────────────

function ProviderCard({
  id, icon, label, tagline, selected, onSelect, status,
}: {
  id: ProviderId;
  icon: React.ReactNode;
  label: string;
  tagline: string;
  selected: boolean;
  onSelect: () => void;
  status: React.ReactNode;
}) {
  return (
    <label
      htmlFor={`provider-${id}`}
      className={`flex min-h-[82px] cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
        selected ? "border-accent bg-accent/5" : "border-border bg-bg-secondary hover:border-text-muted"
      }`}
    >
      <input
        id={`provider-${id}`}
        type="radio"
        name="ai-provider"
        checked={selected}
        onChange={onSelect}
        className="mt-1"
      />
      <div className="flex-1 min-w-0">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
          <span className="text-accent">{icon}</span>
          <span className="text-sm font-medium text-text-primary">{label}</span>
          </div>
          <div className="shrink-0">{status}</div>
        </div>
        <div className="text-xs text-text-muted mt-0.5">{tagline}</div>
      </div>
    </label>
  );
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

function AnthropicStatus() {
  const { data: key, error, isLoading } = useQuery({
    queryKey: ["setting", ANTHROPIC_KEY_SETTING],
    queryFn: () => ipc.getSetting(ANTHROPIC_KEY_SETTING),
    retry: false,
  });
  if (isLoading) return <SettingsStatusBadge tone="neutral" isLoading>checking</SettingsStatusBadge>;
  if (error) return <SettingsStatusBadge tone="error">check failed</SettingsStatusBadge>;
  return key
    ? <SettingsStatusBadge tone="ok">key set</SettingsStatusBadge>
    : <SettingsStatusBadge tone="warn">no key</SettingsStatusBadge>;
}

function AnthropicConfig() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  const { data: storedKey } = useQuery({
    queryKey: ["setting", ANTHROPIC_KEY_SETTING],
    queryFn: () => ipc.getSetting(ANTHROPIC_KEY_SETTING),
  });
  const { data: storedModel } = useQuery({
    queryKey: ["setting", ANTHROPIC_MODEL_SETTING],
    queryFn: () => ipc.getSetting(ANTHROPIC_MODEL_SETTING),
  });

  // Fetched from `GET /v1/models` so we never have to maintain a model list.
  // Sorted newest-first via `created_at`. Only fires when a key is present.
  const { data: models = [], isLoading: modelsLoading, error: modelsError } = useQuery({
    queryKey: ["anthropic-models"],
    queryFn: async () => {
      const list = await invoke<AnthropicModel[]>("list_anthropic_models");
      return [...list].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    },
    enabled: !!storedKey,
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 1,
  });

  const hasKey = !!storedKey;
  const model = storedModel || DEFAULT_ANTHROPIC_MODEL;

  useEffect(() => { setApiKey(""); }, [storedKey]);

  const handleSaveKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("sk-ant-")) {
      toast.error("Anthropic API keys start with 'sk-ant-'");
      return;
    }
    setSavingKey(true);
    try {
      await ipc.setSetting(ANTHROPIC_KEY_SETTING, trimmed);
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["setting", ANTHROPIC_KEY_SETTING] });
      toast.success("API key saved to Keychain");
    } catch (e) {
      toast.error(toUserMessage(e, "Couldn't save the API key"));
    } finally {
      setSavingKey(false);
    }
  };

  const handleClearKey = async () => {
    await ipc.setSetting(ANTHROPIC_KEY_SETTING, "");
    qc.invalidateQueries({ queryKey: ["setting", ANTHROPIC_KEY_SETTING] });
    toast.success("API key removed");
  };

  const handlePickModel = async (id: string) => {
    await ipc.setSetting(ANTHROPIC_MODEL_SETTING, id);
    qc.invalidateQueries({ queryKey: ["setting", ANTHROPIC_MODEL_SETTING] });
    const picked = models.find((m) => m.id === id);
    toast.success(`Model set to ${picked?.display_name ?? id}`);
  };

  return (
    <div className="space-y-5 pl-6 border-l-2 border-accent/30">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label className="text-sm font-medium text-text-primary">API key</label>
          {hasKey
            ? <SettingsStatusBadge tone="ok"><Check size={12} /> stored in Keychain</SettingsStatusBadge>
            : <SettingsStatusBadge tone="warn"><AlertCircle size={12} /> not configured</SettingsStatusBadge>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? "Paste a new key to replace" : "sk-ant-…"}
              className={`${settingsInputClass} w-full pr-9 font-mono`}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              aria-label={showKey ? "Hide key" : "Show key"}
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            onClick={handleSaveKey}
            disabled={!apiKey.trim() || savingKey}
            className={primarySettingsButtonClass}
          >
            {savingKey ? "Saving…" : "Save"}
          </button>
          {hasKey && (
            <button
              onClick={handleClearKey}
              className={secondarySettingsButtonClass}
            >Clear</button>
          )}
        </div>
        <p className="text-xs text-text-muted">
          Get a key at{" "}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank" rel="noopener noreferrer"
            className="text-accent inline-flex items-center gap-1 hover:underline"
          >console.anthropic.com <ExternalLink size={10} /></a>
          . Usage is billed directly by Anthropic.
        </p>
      </section>

      <section className="space-y-2">
        <label className="text-sm font-medium text-text-primary">Model</label>
        {!hasKey && (
          <p className="text-xs text-text-muted">
            Add a key above to see the models your account can access.
          </p>
        )}
        {hasKey && modelsLoading && (
          <p className="text-xs text-text-muted">Loading models…</p>
        )}
        {hasKey && modelsError && (
          <InlineSettingsStatus
            role="alert"
            tone="error"
            title="Model list unavailable"
            message={`Couldn't load model list: ${String(modelsError)}`}
          />
        )}
        {hasKey && !modelsLoading && !modelsError && models.length === 0 && (
          <p className="text-xs text-text-muted">
            No models available for this key. Check
            <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer"
               className="text-accent hover:underline ml-1">console.anthropic.com</a>.
          </p>
        )}
        {hasKey && models.length > 0 && (
          <div className="space-y-1.5">
            {models.map((m) => (
              <label key={m.id} className={`flex min-h-[72px] cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                model === m.id ? "border-accent bg-accent/5" : "border-border bg-bg-secondary hover:border-text-muted"
              }`}>
                <input
                  type="radio" name="anthropic-model"
                  checked={model === m.id}
                  onChange={() => handlePickModel(m.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-text-primary">{m.display_name}</span>
                    <span className="text-footnote font-mono text-text-muted truncate">{m.id}</span>
                  </div>
                  <div className="text-xs text-text-muted">{tierHint(m.id)}</div>
                </div>
              </label>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

function OllamaStatus() {
  const { data: running, error, isLoading } = useQuery({
    queryKey: ["ollama-running"],
    queryFn: () => invoke<boolean>("is_ollama_running"),
    refetchInterval: 5000,
    retry: false,
  });
  if (isLoading) return <SettingsStatusBadge tone="neutral" isLoading>checking</SettingsStatusBadge>;
  if (error) return <SettingsStatusBadge tone="error">check failed</SettingsStatusBadge>;
  return running
    ? <SettingsStatusBadge tone="ok">running</SettingsStatusBadge>
    : <SettingsStatusBadge tone="warn">not running</SettingsStatusBadge>;
}

function OllamaConfig() {
  const qc = useQueryClient();
  const { data: running } = useQuery({
    queryKey: ["ollama-running"],
    queryFn: () => invoke<boolean>("is_ollama_running"),
    refetchInterval: 5000,
  });
  const { data: models = [], error: modelsError } = useQuery({
    queryKey: ["ollama-models"],
    queryFn: () => invoke<string[]>("list_ollama_models"),
    enabled: !!running,
    retry: false,
  });
  const { data: storedModel } = useQuery({
    queryKey: ["setting", OLLAMA_MODEL_SETTING],
    queryFn: () => ipc.getSetting(OLLAMA_MODEL_SETTING),
  });
  const model = storedModel || DEFAULT_OLLAMA_MODEL;

  const handlePickModel = async (id: string) => {
    await ipc.setSetting(OLLAMA_MODEL_SETTING, id);
    qc.invalidateQueries({ queryKey: ["setting", OLLAMA_MODEL_SETTING] });
    toast.success(`Model set to ${id}`);
  };

  return (
    <div className="space-y-3 pl-6 border-l-2 border-accent/30">
      <p className="m-0 text-xs text-text-muted">
        Recommended: <code className="font-mono">qwen3:8b</code> (16&nbsp;GB Macs) ·{" "}
        <code className="font-mono">qwen3:4b</code> at 8&nbsp;GB ·{" "}
        <code className="font-mono">qwen3:30b-a3b</code> at 32&nbsp;GB. Prefer instruct
        variants — "thinking" models can break structured notes output.
      </p>
      {!running && (
        <div className="space-y-2 rounded-lg border border-warning/25 bg-warning/5 p-3 text-xs text-text-secondary">
          <div className="flex items-center gap-2 font-medium text-warning">
            <AlertCircle size={14} /> Ollama is not running
          </div>
          <p>Install Ollama (one-time):</p>
          <pre className="font-mono text-caption bg-bg-tertiary p-2 rounded">brew install ollama
ollama serve &amp;
ollama pull qwen3:8b</pre>
          <p>
            Once <code className="font-mono">ollama serve</code> is running and
            you've pulled at least one model, this section will populate.
          </p>
        </div>
      )}

      {running && (
        <section className="space-y-2">
          <label className="text-sm font-medium text-text-primary">Model</label>
          {modelsError && (
            <InlineSettingsStatus
              role="alert"
              tone="error"
              title="Ollama model check failed"
              message={`Couldn't list Ollama models: ${String(modelsError)}`}
            />
          )}
          {models.length === 0 && !modelsError && (
            <p className="text-xs text-text-muted">
              No models installed. Run <code className="font-mono">ollama pull qwen3:8b</code> in
              your terminal, then come back here.
            </p>
          )}
          {models.length > 0 && (
            <div className="space-y-1">
              {models.map((m) => (
                <label key={m} className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border p-2.5 transition-colors ${
                  model === m ? "border-accent bg-accent/5" : "border-border bg-bg-secondary hover:border-text-muted"
                }`}>
                  <input
                    type="radio" name="ollama-model"
                    checked={model === m}
                    onChange={() => handlePickModel(m)}
                  />
                  <span className="text-sm font-mono text-text-primary">{m}</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-text-muted">
            Recommended: an 8B-class instruct model with JSON-mode support
            (Llama 3.2, Qwen 2.5, etc.). Smaller models may not adhere to the
            note schema reliably.
          </p>
        </section>
      )}
    </div>
  );
}

// ─── Apple Intelligence ──────────────────────────────────────────────────────

function AppleStatus() {
  const { data: available, error, isLoading } = useQuery({
    queryKey: ["apple-ai-available"],
    queryFn: () => invoke<boolean>("is_apple_ai_available"),
    retry: false,
  });
  if (isLoading) return <SettingsStatusBadge tone="neutral" isLoading>checking</SettingsStatusBadge>;
  if (error) return <SettingsStatusBadge tone="error">check failed</SettingsStatusBadge>;
  return available
    ? <SettingsStatusBadge tone="ok">available</SettingsStatusBadge>
    : <SettingsStatusBadge tone="warn">unavailable</SettingsStatusBadge>;
}

function AppleConfig() {
  const { data: available } = useQuery({
    queryKey: ["apple-ai-available"],
    queryFn: () => invoke<boolean>("is_apple_ai_available"),
  });
  return (
    <div className="space-y-3 pl-6 border-l-2 border-accent/30 text-xs text-text-secondary">
      {available ? (
        <InlineSettingsStatus
          tone="ok"
          title="Apple Intelligence available"
          message="Note generation, chat, and speaker detection will run on Apple's on-device model."
        />
      ) : (
        <InlineSettingsStatus
          tone="warn"
          title="Apple Intelligence is not available"
          message="Make sure you are on macOS 26 or newer with Apple Intelligence enabled in System Settings. Models need to finish downloading before they can be used."
        />
      )}
      <p className="text-text-muted">
        Apple's on-device model is good for chat and decent at telling
        speakers apart, but it may miss subtle action items in long meetings.
        If quality suffers, switch back to Anthropic or Ollama.
      </p>
    </div>
  );
}
