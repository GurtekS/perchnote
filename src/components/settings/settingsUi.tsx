import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, Loader2 } from "lucide-react";

export type SettingsTone = "neutral" | "ok" | "warn" | "error";

export const settingsFocusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";

export const primarySettingsButtonClass =
  `btn btn-primary btn-lg ${settingsFocusRing}`;

export const secondarySettingsButtonClass =
  `btn btn-secondary btn-lg ${settingsFocusRing}`;

/* Compact (32px default-.btn) variants for dense rows — replaces the old
   per-site `min-h-8 px-2.5 py-1 text-xs` overrides. */
export const primarySettingsButtonCompactClass =
  `btn btn-primary ${settingsFocusRing}`;

export const secondarySettingsButtonCompactClass =
  `btn btn-secondary ${settingsFocusRing}`;

export const settingsInputClass =
  `rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent ${settingsFocusRing}`;

export function SettingsSectionHeader({
  badge,
  description,
  title,
}: {
  badge?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-text-muted">{description}</p>
      </div>
      {badge && <div className="shrink-0">{badge}</div>}
    </div>
  );
}

export function SettingsSubsectionHeader({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {description && (
          <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function SettingsStatusBadge({
  children,
  isLoading = false,
  tone,
}: {
  children: ReactNode;
  isLoading?: boolean;
  tone: SettingsTone;
}) {
  const toneClass =
    tone === "ok"
      ? "bg-accent/10 text-accent"
      : tone === "warn"
        ? "bg-warning/10 text-warning"
        : tone === "error"
          ? "bg-recording/10 text-recording"
          : "bg-bg-hover text-text-muted";

  return (
    <span
      className={`inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full px-2 py-1 text-caption font-medium ${toneClass}`}
    >
      {isLoading && <Loader2 size={11} className="animate-spin" />}
      {children}
    </span>
  );
}

export function SettingsCard({
  children,
  className = "",
  selected = false,
}: {
  children: ReactNode;
  className?: string;
  selected?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        selected ? "border-accent bg-accent/5" : "border-border bg-bg-secondary"
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function InlineSettingsStatus({
  className = "",
  message,
  role,
  title,
  tone,
}: {
  className?: string;
  message: string;
  role?: "alert" | "status";
  title: string;
  tone: Exclude<SettingsTone, "ok"> | "ok";
}) {
  const toneClass =
    tone === "ok"
      ? "border-accent/25 bg-accent/5 text-accent"
      : tone === "warn"
        ? "border-warning/25 bg-warning/5 text-warning"
        : tone === "error"
          ? "border-recording/25 bg-recording/5 text-recording"
          : "border-border bg-bg-tertiary text-text-secondary";
  const Icon = tone === "ok" ? CheckCircle2 : tone === "neutral" ? Info : AlertCircle;

  return (
    <div
      role={role}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${toneClass} ${className}`}
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block break-words text-xs leading-5 text-text-secondary">
          {message}
        </span>
      </span>
    </div>
  );
}
