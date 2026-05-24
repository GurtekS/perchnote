import { useState, useRef, useEffect } from "react";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sun,
  Moon,
  Monitor,
  RotateCcw,
} from "lucide-react";
import { useThemeStore } from "../../stores/themeStore";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";

const ACCENT_PRESETS = [
  { name: "Forest", hex: "#5a9c6a" },
  { name: "Ocean",  hex: "#4a90d9" },
  { name: "Sunset", hex: "#d97c4a" },
  { name: "Violet", hex: "#7c6aaa" },
  { name: "Rose",   hex: "#c05070" },
  { name: "Mono",   hex: "#888888" },
];

const themes = [
  { id: "light" as const, label: "Light", icon: Sun },
  { id: "dark" as const, label: "Dark", icon: Moon },
  { id: "system" as const, label: "System", icon: Monitor },
];

export function GeneralSettings() {
  const { theme, setTheme, accentColor, setAccentColor, clearCustomAccent } = useThemeStore();
  const queryClient = useQueryClient();
  const [customHex, setCustomHex] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const contextDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: savedUserContext = "" } = useQuery({
    queryKey: ["setting", "user_context"],
    queryFn: () => ipc.getSetting("user_context").then((v) => v ?? ""),
  });

  const handleUserContextChange = (value: string) => {
    if (contextDebounceRef.current) clearTimeout(contextDebounceRef.current);
    contextDebounceRef.current = setTimeout(async () => {
      await ipc.setSetting("user_context", value);
      queryClient.invalidateQueries({ queryKey: ["setting", "user_context"] });
    }, 600);
  };

  // Sync customHex input when accent changes externally
  useEffect(() => {
    const isPreset = ACCENT_PRESETS.some((p) => p.hex === accentColor);
    if (!isPreset) setCustomHex(accentColor);
  }, [accentColor]);

  const handleCustomHexChange = (hex: string) => {
    setCustomHex(hex);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      debounceRef.current = setTimeout(() => setAccentColor(hex), 300);
    }
  };

  // Templates query for default template picker
  const { data: templates = [] } = useQuery({
    queryKey: ["templates"],
    queryFn: ipc.listTemplates,
  });

  const { data: savedDefaultTemplate } = useQuery({
    queryKey: ["setting", "default_template_id"],
    queryFn: () => ipc.getSetting("default_template_id"),
  });

  const handleDefaultTemplateChange = async (templateId: string) => {
    await ipc.setSetting("default_template_id", templateId);
    queryClient.invalidateQueries({ queryKey: ["setting", "default_template_id"] });
    const name = templates.find((t) => t.id === templateId)?.name || "None";
    toast.success(`Default template set to ${name}`);
  };

  const handleResetAll = async () => {
    setShowResetDialog(false);
    const keys = [
      "theme", "audio_device", "whisper_model", "whisper_language",
      "noise_cancellation", "default_template_id", "retention_days",
      "google_client_id", "google_client_secret",
      "microsoft_client_id", "microsoft_client_secret",
      "user_context", "custom_vocabulary",
    ];
    for (const key of keys) {
      await ipc.setSetting(key, "");
    }
    clearCustomAccent();
    setTheme("system");
    toast.success("All settings reset to defaults");
    queryClient.invalidateQueries();
  };

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <h2 className="text-base font-semibold text-text-primary mb-0.5">General</h2>
        <p className="text-xs text-text-muted">Appearance and default behaviors.</p>
      </div>

      {/* Theme */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Theme</h3>
        <p className="text-xs text-text-muted mb-3">Choose how Perchnote looks.</p>
        <div className="grid grid-cols-3 gap-3">
          {themes.map((t) => {
            const Icon = t.icon;
            const isActive = theme === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-all ${
                  isActive
                    ? "border-accent bg-accent/5 text-accent"
                    : "border-border text-text-secondary hover:border-border hover:bg-bg-tertiary"
                }`}
              >
                <Icon size={20} />
                <span className="text-xs font-medium">{t.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Accent Color */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Accent Color</h3>
        <p className="text-xs text-text-muted mb-3">Customize the app's highlight color.</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {ACCENT_PRESETS.map((preset) => {
            const isActive = accentColor === preset.hex;
            return (
              <button
                key={preset.hex}
                onClick={() => { setAccentColor(preset.hex); setCustomHex(""); }}
                title={preset.name}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                  isActive
                    ? "border-accent bg-accent/5 text-accent"
                    : "border-border text-text-secondary hover:bg-bg-tertiary"
                }`}
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ background: preset.hex }}
                />
                {preset.name}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={accentColor}
            onChange={(e) => { setAccentColor(e.target.value); setCustomHex(""); }}
            className="w-8 h-8 rounded cursor-pointer border border-border bg-transparent p-0.5"
            title="Pick a custom color"
          />
          <input
            type="text"
            value={customHex || (ACCENT_PRESETS.some((p) => p.hex === accentColor) ? "" : accentColor)}
            onChange={(e) => handleCustomHexChange(e.target.value)}
            placeholder="#5a9c6a"
            maxLength={7}
            className="w-28 bg-bg-tertiary text-text-primary text-xs rounded-lg px-2.5 py-1.5 border border-border focus:outline-none focus:border-accent font-mono"
          />
          <span className="text-xs text-text-muted">Custom hex</span>
        </div>
      </section>

      {/* About You */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">About You</h3>
        <p className="text-xs text-text-muted mb-3">
          Add context about your role to improve AI note quality. For example: "Product manager at a B2B SaaS startup focused on enterprise deals."
        </p>
        <textarea
          key={savedUserContext}
          defaultValue={savedUserContext}
          onChange={(e) => handleUserContextChange(e.target.value)}
          placeholder="E.g. Senior engineer at Acme Corp, working on the payments team…"
          rows={3}
          className="w-full bg-bg-tertiary text-text-primary text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent resize-none placeholder:text-text-muted/50"
        />
      </section>

      {/* Default Template */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Default Template</h3>
        <p className="text-xs text-text-muted mb-3">Choose the template used when generating notes.</p>
        <select
          value={savedDefaultTemplate || ""}
          onChange={(e) => handleDefaultTemplateChange(e.target.value)}
          className="w-full bg-bg-tertiary text-text-primary text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
        >
          <option value="">None (use built-in default)</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.is_default ? " (current default)" : ""}
            </option>
          ))}
        </select>
      </section>

      {/* Reset */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Reset</h3>
        <p className="text-xs text-text-muted mb-3">Start fresh with default settings.</p>
        <button
          onClick={() => setShowResetDialog(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border border-recording/40 text-recording hover:bg-recording/5 transition-colors"
        >
          <RotateCcw size={14} />
          Reset all settings to defaults
        </button>
      </section>

      {/* About */}
      <div className="pt-4 border-t border-border">
        <p className="text-xs text-text-muted">Perchnote v0.1.0</p>
      </div>

      <ConfirmDialog
        open={showResetDialog}
        onCancel={() => setShowResetDialog(false)}
        onConfirm={handleResetAll}
        title="Reset all data?"
        message="This will reset all settings to their default values. Your meetings and notes will not be affected."
        confirmLabel="Reset All"
        variant="danger"
      />
    </div>
  );
}
