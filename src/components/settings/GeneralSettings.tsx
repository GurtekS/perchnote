import { useState, useRef, useEffect } from "react";
import {
  applyEditorFontSize,
  EDITOR_FONT_SIZE_KEY,
  EDITOR_FONT_SIZES,
} from "../../lib/editorFontSize";
import { getVersion } from "@tauri-apps/api/app";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sun,
  Moon,
  Monitor,
  RotateCcw,
  Loader2,
} from "lucide-react";
import { useThemeStore } from "../../stores/themeStore";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { secondarySettingsButtonCompactClass, settingsInputClass } from "./settingsUi";

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

  const { data: appVersion = "" } = useQuery({
    queryKey: ["app-version"],
    queryFn: getVersion,
    staleTime: Infinity,
  });

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

  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const r = await ipc.checkForUpdate();
      if (r.update_available) {
        toast.action(
          `Perchnote ${r.latest} is available (you have ${r.current})`,
          "View release",
          () => ipc.openUrl(r.url),
        );
      } else {
        toast.success(`You're on the latest version (${r.current})`);
      }
    } catch (e) {
      toast.error(toUserMessage(e));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const { data: fontSize = "16px" } = useQuery({
    queryKey: ["setting", EDITOR_FONT_SIZE_KEY],
    queryFn: () => ipc.getSetting(EDITOR_FONT_SIZE_KEY).then((v) => v || "16px"),
  });
  const handleFontSizeChange = async (px: string) => {
    await ipc.setSetting(EDITOR_FONT_SIZE_KEY, px);
    applyEditorFontSize(px);
    queryClient.invalidateQueries({ queryKey: ["setting", EDITOR_FONT_SIZE_KEY] });
  };

  const handleResetAll = async () => {
    setShowResetDialog(false);
    const keys = [
      "theme", "audio_device", "whisper_model", "whisper_language",
      "noise_cancellation", "retention_days",
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
        <p className="text-xs text-text-muted">
          Appearance, editor, updates, and reset. AI note behavior lives in
          the AI section; the default template in Templates.
        </p>
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

      {/* Updates */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Updates</h3>
        <p className="text-xs text-text-muted mb-2">
          Checks GitHub for a newer release when you ask — nothing runs
          automatically and nothing is sent beyond the request itself.
        </p>
        <button
          type="button"
          onClick={handleCheckUpdate}
          disabled={checkingUpdate}
          className={secondarySettingsButtonCompactClass}
        >
          {checkingUpdate ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          Check for updates
        </button>
      </section>

      {/* Editor font size */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Editor Font Size</h3>
        <p className="text-xs text-text-muted mb-3">
          Applies to your notes and AI notes (AI notes render one step tighter).
        </p>
        <select
          value={fontSize}
          onChange={(e) => handleFontSizeChange(e.target.value)}
          aria-label="Editor font size"
          className={`${settingsInputClass} w-full`}
        >
          {EDITOR_FONT_SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
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
        <p className="text-xs text-text-muted">Perchnote{appVersion ? ` v${appVersion}` : ""}</p>
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
