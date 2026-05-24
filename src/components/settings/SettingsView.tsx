import { useEffect, useState } from "react";
import {
  ArrowRight,
  Bell,
  Calendar,
  Database,
  FileText,
  Keyboard,
  ListChecks,
  Mic,
  RotateCw,
  Sparkles,
  Sun,
} from "lucide-react";
import { GeneralSettings } from "./GeneralSettings";
import { AudioSettings } from "./AudioSettings";
import { DataSettings } from "./DataSettings";
import { CalendarSettings } from "./CalendarSettings";
import { TemplateSettings } from "./TemplateSettings";
import { NotificationSettings } from "./NotificationSettings";
import { AiSettings } from "./AiSettings";

export const SETTINGS_SECTION_IDS = [
  "general",
  "setup",
  "ai",
  "calendar",
  "audio",
  "data",
  "templates",
  "notifications",
  "shortcuts",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTION_IDS)[number];

const SHORTCUTS = [
  { keys: "⌘N", description: "New meeting" },
  { keys: "⌘E", description: "Enhance notes" },
  { keys: "⌘T", description: "Toggle transcript" },
  { keys: "⌘K", description: "Command palette" },
  { keys: "⌘,", description: "Settings" },
  { keys: "⌘F", description: "Search" },
  { keys: "Escape", description: "Close / go back" },
];

const navItems: { id: SettingsSection; label: string; icon: typeof Sun }[] = [
  { id: "general",   label: "General",   icon: Sun },
  { id: "setup",     label: "Setup Guide", icon: ListChecks },
  { id: "ai",        label: "AI",        icon: Sparkles },
  { id: "calendar",  label: "Calendar",  icon: Calendar },
  { id: "audio",     label: "Audio",     icon: Mic },
  { id: "data",      label: "Data",      icon: Database },
  { id: "templates",      label: "Templates",      icon: FileText },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "shortcuts",     label: "Shortcuts",     icon: Keyboard },
];

interface SettingsViewProps {
  initialSection?: SettingsSection;
  onRunSetup?: () => void;
  onSectionChange?: (section: SettingsSection) => void;
}

export function SettingsView({
  initialSection,
  onRunSetup,
  onSectionChange,
}: SettingsViewProps = {}) {
  const [active, setActive] = useState<SettingsSection>(initialSection ?? "general");

  useEffect(() => {
    if (initialSection) {
      setActive(initialSection);
    }
  }, [initialSection]);

  const handleSectionChange = (section: SettingsSection) => {
    setActive(section);
    onSectionChange?.(section);
  };

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Sidebar nav */}
      <nav className="flex w-full shrink-0 gap-0.5 overflow-x-auto border-b border-border px-2 py-3 md:w-44 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:py-4">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => handleSectionChange(id)}
            className={`flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors md:w-full ${
              active === id
                ? "bg-accent/10 text-accent font-medium"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            <Icon size={14} className="shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 tab-content-enter md:px-8 md:py-6">
        {active === "general"   && <GeneralSettings />}
        {active === "setup"     && (
          <SetupGuidePanel
            onRunSetup={onRunSetup}
            onSelectSection={handleSectionChange}
          />
        )}
        {active === "ai"        && <AiSettings />}
        {active === "calendar"  && <CalendarSettings />}
        {active === "audio"     && <AudioSettings />}
        {active === "data"      && <DataSettings />}
        {active === "templates"      && <TemplateSettings />}
        {active === "notifications" && <NotificationSettings />}
        {active === "shortcuts" && <ShortcutsPanel />}
      </div>
    </div>
  );
}

function SetupGuidePanel({
  onRunSetup,
  onSelectSection,
}: {
  onRunSetup?: () => void;
  onSelectSection: (section: SettingsSection) => void;
}) {
  const repairSections: Array<{
    section: SettingsSection;
    label: string;
    description: string;
    icon: typeof Sun;
  }> = [
    {
      section: "audio",
      label: "Fix audio setup",
      description: "Choose a microphone, check transcription models, and confirm recording defaults.",
      icon: Mic,
    },
    {
      section: "ai",
      label: "Configure AI notes",
      description: "Pick a note provider, verify key status, or keep AI disabled until later.",
      icon: Sparkles,
    },
    {
      section: "calendar",
      label: "Connect calendar",
      description: "Add Google, Microsoft, or read-only ICS calendars for upcoming meetings.",
      icon: Calendar,
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-0.5">Setup Guide</h2>
        <p className="text-xs text-text-muted">
          Review setup checks or jump directly to repair screens. Recording works without optional AI or calendar services.
        </p>
      </div>

      <section className="rounded-lg border border-border bg-bg-secondary p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Replay onboarding</h3>
            <p className="mt-1 text-xs text-text-muted">
              Opens the setup walkthrough in preview mode without changing first-run completion.
            </p>
          </div>
          <button
            type="button"
            onClick={onRunSetup}
            disabled={!onRunSetup}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCw size={14} />
            Replay setup guide
          </button>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Repair setup</h3>
        <div className="grid gap-2 lg:grid-cols-3">
          {repairSections.map(({ section, label, description, icon: Icon }) => (
            <button
              key={section}
              type="button"
              onClick={() => onSelectSection(section)}
              className="flex min-h-[92px] items-start gap-3 rounded-lg border border-border bg-bg-secondary p-3 text-left transition-colors hover:border-text-muted hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-primary">{label}</span>
                <span className="mt-1 block text-xs leading-5 text-text-muted">{description}</span>
              </span>
              <ArrowRight size={14} className="mt-1 shrink-0 text-text-muted" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ShortcutsPanel() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-0.5">Keyboard Shortcuts</h2>
        <p className="text-xs text-text-muted">Quick reference for available shortcuts.</p>
      </div>
      <div className="grid gap-y-1.5 md:grid-cols-2 md:gap-x-8">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="flex min-w-0 items-center justify-between gap-3 border-b border-border/50 py-1.5">
            <span className="min-w-0 text-sm text-text-secondary">{s.description}</span>
            <kbd className="shrink-0 rounded border border-border bg-bg-tertiary px-2 py-0.5 font-mono text-[11px] text-text-muted">{s.keys}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
