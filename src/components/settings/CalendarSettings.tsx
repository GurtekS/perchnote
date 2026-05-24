import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Link2,
  Unlink,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  Globe,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import {
  InlineSettingsStatus,
  SettingsCard,
  SettingsSectionHeader,
  SettingsStatusBadge,
  SettingsSubsectionHeader,
  primarySettingsButtonClass,
  secondarySettingsButtonClass,
  settingsInputClass,
} from "./settingsUi";

export function CalendarSettings() {
  const queryClient = useQueryClient();
  const [icsUrl, setIcsUrl] = useState("");
  const [isAddingIcs, setIsAddingIcs] = useState(false);
  const [isSyncingIcs, setIsSyncingIcs] = useState(false);
  const [icsSyncResult, setIcsSyncResult] = useState<{ count: number; time: Date } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [msClientId, setMsClientId] = useState("");
  const [msClientSecret, setMsClientSecret] = useState("");
  const [isMsConnecting, setIsMsConnecting] = useState(false);
  const [showGoogleSetup, setShowGoogleSetup] = useState(false);
  const [showMicrosoftSetup, setShowMicrosoftSetup] = useState(false);
  const [pastDays, setPastDays] = useState(7);
  const [futureDays, setFutureDays] = useState(30);

  const { data: icsUrls = [], error: icsUrlsError, isLoading: icsUrlsLoading } = useQuery({
    queryKey: ["ics-urls"],
    queryFn: ipc.listIcsUrls,
    retry: false,
  });
  const { data: isGoogleConnected, error: googleConnectedError, isLoading: googleConnectedLoading } = useQuery({
    queryKey: ["calendar-connected"],
    queryFn: () => invoke<boolean>("is_calendar_connected"),
    retry: false,
  });
  const { data: hasGoogleCredentials, error: googleCredentialsError, isLoading: googleCredentialsLoading } = useQuery({
    queryKey: ["calendar-credentials"],
    queryFn: ipc.hasGoogleCredentials,
    retry: false,
  });
  const { data: isMicrosoftConnected, error: microsoftConnectedError, isLoading: microsoftConnectedLoading } = useQuery({
    queryKey: ["microsoft-connected"],
    queryFn: ipc.isMicrosoftConnected,
    retry: false,
  });
  const { data: hasMicrosoftCredentials, error: microsoftCredentialsError, isLoading: microsoftCredentialsLoading } = useQuery({
    queryKey: ["microsoft-credentials"],
    queryFn: ipc.hasMicrosoftCredentials,
    retry: false,
  });
  const { data: savedPastDays } = useQuery({
    queryKey: ["setting", "calendar_sync_past_days"],
    queryFn: () => ipc.getSetting("calendar_sync_past_days"),
  });
  const { data: savedFutureDays } = useQuery({
    queryKey: ["setting", "calendar_sync_future_days"],
    queryFn: () => ipc.getSetting("calendar_sync_future_days"),
  });

  useEffect(() => { if (savedPastDays) setPastDays(Number(savedPastDays)); }, [savedPastDays]);
  useEffect(() => { if (savedFutureDays) setFutureDays(Number(savedFutureDays)); }, [savedFutureDays]);
  const connectionCheckLoading =
    googleConnectedLoading ||
    googleCredentialsLoading ||
    microsoftConnectedLoading ||
    microsoftCredentialsLoading ||
    icsUrlsLoading;
  const connectionCheckError =
    googleConnectedError ||
    googleCredentialsError ||
    microsoftConnectedError ||
    microsoftCredentialsError ||
    icsUrlsError;
  const configuredCalendarCount =
    Number(!!isGoogleConnected) +
    Number(!!isMicrosoftConnected) +
    Number(icsUrls.length > 0);

  const handleAddIcs = async () => {
    if (!icsUrl.trim()) return;
    setIsAddingIcs(true); setError(null);
    try {
      await ipc.addIcsUrl(icsUrl.trim());
      setIcsUrl("");
      queryClient.invalidateQueries({ queryKey: ["ics-urls"] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      toast.success("Calendar feed added");
    } catch (e) { setError(`Failed to add calendar: ${e}`); }
    finally { setIsAddingIcs(false); }
  };

  const handleSyncIcs = async () => {
    setIsSyncingIcs(true); setError(null);
    try {
      const count = await ipc.syncIcsCalendars(pastDays, futureDays);
      setIcsSyncResult({ count, time: new Date() });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      toast.success(`Synced ${count} event${count !== 1 ? "s" : ""}`);
    } catch (e) { setError(`Sync failed: ${e}`); }
    finally { setIsSyncingIcs(false); }
  };

  const handleRemoveIcs = async (url: string) => {
    await ipc.removeIcsUrl(url);
    queryClient.invalidateQueries({ queryKey: ["ics-urls"] });
    toast.success("Calendar feed removed");
  };

  const handleGoogleConnect = async () => {
    setIsConnecting(true); setError(null);
    try {
      if (clientId && clientSecret) {
        await ipc.setSetting("google_client_id", clientId);
        await ipc.setSetting("google_client_secret", clientSecret);
      }
      await ipc.startGoogleOAuth();
      queryClient.invalidateQueries({ queryKey: ["calendar-connected"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-credentials"] });
      toast.success("Google Calendar connected");
    } catch (e) { setError(String(e)); }
    finally { setIsConnecting(false); }
  };

  const handleGoogleDisconnect = async () => {
    await ipc.disconnectGoogle();
    queryClient.invalidateQueries({ queryKey: ["calendar-connected"] });
    queryClient.invalidateQueries({ queryKey: ["calendar-credentials"] });
    toast.success("Google Calendar disconnected");
  };

  const handleMicrosoftConnect = async () => {
    setIsMsConnecting(true); setError(null);
    try {
      if (msClientId && msClientSecret) {
        await ipc.setSetting("microsoft_client_id", msClientId);
        await ipc.setSetting("microsoft_client_secret", msClientSecret);
      }
      await ipc.startMicrosoftOAuth();
      queryClient.invalidateQueries({ queryKey: ["microsoft-connected"] });
      queryClient.invalidateQueries({ queryKey: ["microsoft-credentials"] });
      toast.success("Microsoft Calendar connected");
    } catch (e) { setError(String(e)); }
    finally { setIsMsConnecting(false); }
  };

  const handleMicrosoftDisconnect = async () => {
    await ipc.disconnectMicrosoft();
    queryClient.invalidateQueries({ queryKey: ["microsoft-connected"] });
    queryClient.invalidateQueries({ queryKey: ["microsoft-credentials"] });
    toast.success("Microsoft Calendar disconnected");
  };

  return (
    <div className="space-y-6">
      <SettingsSectionHeader
        title="Calendar"
        description="Connect calendars to add upcoming meetings automatically. Recording still works when no calendar is connected."
        badge={
          <SettingsStatusBadge
            tone={connectionCheckError ? "error" : configuredCalendarCount > 0 ? "ok" : "warn"}
            isLoading={connectionCheckLoading}
          >
            {connectionCheckLoading
              ? "checking"
              : connectionCheckError
                ? "check failed"
                : configuredCalendarCount > 0
                  ? `${configuredCalendarCount} configured`
                  : "not connected"}
          </SettingsStatusBadge>
        }
      />

      {error && (
        <InlineSettingsStatus
          role="alert"
          tone="error"
          title="Calendar action failed"
          message={error}
        />
      )}

      {/* Google Calendar */}
      <section>
        <SettingsSubsectionHeader
          title="Google Calendar"
          description="Use Google OAuth to bring upcoming meetings into Perchnote."
          action={
            <CalendarProviderStatus
              connected={!!isGoogleConnected}
              credentialsReady={!!hasGoogleCredentials}
              error={googleConnectedError || googleCredentialsError}
              isLoading={googleConnectedLoading || googleCredentialsLoading}
            />
          }
        />
        <SettingsCard>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Calendar size={14} className="text-text-muted" />
              <span className="text-sm text-text-primary">Google Calendar</span>
            </div>
            {isGoogleConnected ? (
              <button onClick={handleGoogleDisconnect} className={`${secondarySettingsButtonClass} min-h-8 px-2.5 py-1 text-xs`}>
                <Unlink size={10} />Disconnect
              </button>
            ) : (
              <button onClick={() => setShowGoogleSetup(!showGoogleSetup)} className={`${primarySettingsButtonClass} min-h-8 px-2.5 py-1 text-xs`}>
                <Link2 size={10} />Connect
              </button>
            )}
          </div>
          {isGoogleConnected && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
              <p className="text-xs text-accent">Connected</p>
            </div>
          )}
          {!isGoogleConnected && hasGoogleCredentials && (
            <p className="mt-2 text-xs text-text-muted">
              OAuth credentials are saved in Keychain-backed settings. Authorize when you want sync.
            </p>
          )}
          {showGoogleSetup && !isGoogleConnected && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-text-muted">Requires a Google Cloud Console project with Calendar API enabled.</p>
              <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" className={`${settingsInputClass} w-full`} autoComplete="off" />
              <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client Secret" className={`${settingsInputClass} w-full`} autoComplete="off" />
              <button onClick={handleGoogleConnect} disabled={isConnecting || (!hasGoogleCredentials && (!clientId || !clientSecret))} className={primarySettingsButtonClass} aria-busy={isConnecting}>
                <Link2 size={12} />{isConnecting ? "Waiting for authorization..." : "Authorize"}
              </button>
            </div>
          )}
        </SettingsCard>
      </section>

      {/* Microsoft Calendar */}
      <section>
        <SettingsSubsectionHeader
          title="Microsoft Calendar"
          description="Use Microsoft Graph OAuth to sync Outlook and Teams meetings."
          action={
            <CalendarProviderStatus
              connected={!!isMicrosoftConnected}
              credentialsReady={!!hasMicrosoftCredentials}
              error={microsoftConnectedError || microsoftCredentialsError}
              isLoading={microsoftConnectedLoading || microsoftCredentialsLoading}
            />
          }
        />
        <SettingsCard>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-text-muted" />
              <span className="text-sm text-text-primary">Microsoft Calendar</span>
            </div>
            {isMicrosoftConnected ? (
              <button onClick={handleMicrosoftDisconnect} className={`${secondarySettingsButtonClass} min-h-8 px-2.5 py-1 text-xs`}>
                <Unlink size={10} />Disconnect
              </button>
            ) : (
              <button onClick={() => setShowMicrosoftSetup(!showMicrosoftSetup)} className={`${primarySettingsButtonClass} min-h-8 px-2.5 py-1 text-xs`}>
                <Link2 size={10} />Connect
              </button>
            )}
          </div>
          {isMicrosoftConnected && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
              <p className="text-xs text-accent">Connected</p>
            </div>
          )}
          {!isMicrosoftConnected && hasMicrosoftCredentials && (
            <p className="mt-2 text-xs text-text-muted">
              Microsoft app credentials are saved in Keychain-backed settings. Authorize when you want sync.
            </p>
          )}
          {showMicrosoftSetup && !isMicrosoftConnected && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-text-muted">Requires an Azure AD app registration with Calendar.Read permission.</p>
              <input type="text" value={msClientId} onChange={(e) => setMsClientId(e.target.value)} placeholder="Application (client) ID" className={`${settingsInputClass} w-full`} autoComplete="off" />
              <input type="password" value={msClientSecret} onChange={(e) => setMsClientSecret(e.target.value)} placeholder="Client Secret" className={`${settingsInputClass} w-full`} autoComplete="off" />
              <button onClick={handleMicrosoftConnect} disabled={isMsConnecting || (!hasMicrosoftCredentials && (!msClientId || !msClientSecret))} className={primarySettingsButtonClass} aria-busy={isMsConnecting}>
                <Link2 size={12} />{isMsConnecting ? "Waiting for authorization..." : "Authorize"}
              </button>
            </div>
          )}
        </SettingsCard>
      </section>

      {/* ICS Calendar Feeds */}
      <section>
        <SettingsSubsectionHeader
          title="ICS Calendar Feeds"
          description="Add read-only calendar feeds from Google Calendar, Outlook, or another calendar app."
          action={
            <SettingsStatusBadge
              tone={icsUrlsError ? "error" : icsUrls.length > 0 ? "ok" : "neutral"}
              isLoading={icsUrlsLoading}
            >
              {icsUrlsLoading
                ? "checking"
                : icsUrlsError
                  ? "check failed"
                  : icsUrls.length > 0
                    ? `${icsUrls.length} ${icsUrls.length === 1 ? "feed" : "feeds"}`
                    : "no feeds"}
            </SettingsStatusBadge>
          }
        />
        <SettingsCard className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Calendar size={14} className="text-text-muted" />
              <span className="text-sm text-text-primary">ICS Feeds</span>
              {icsUrls.length > 0 && (
                <span className="text-[11px] bg-accent/10 text-accent px-1.5 py-0.5 rounded-full">{icsUrls.length}</span>
              )}
            </div>
            {icsUrls.length > 0 && (
              <button onClick={handleSyncIcs} disabled={isSyncingIcs} className={`${secondarySettingsButtonClass} min-h-8 px-2.5 py-1 text-xs`} aria-busy={isSyncingIcs}>
                {isSyncingIcs ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                {isSyncingIcs ? "Syncing..." : "Sync now"}
              </button>
            )}
          </div>

          {icsUrlsError && (
            <InlineSettingsStatus
              role="alert"
              tone="error"
              title="ICS feed check failed"
              message={String(icsUrlsError)}
            />
          )}

          {icsSyncResult && (
            <p className="text-[11px] text-accent">
              Last sync: {icsSyncResult.count} event{icsSyncResult.count !== 1 ? "s" : ""} at{" "}
              {icsSyncResult.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}

          {/* Sync date range */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-text-muted whitespace-nowrap">Past days</label>
              <input type="number" min={0} max={365} value={pastDays} onChange={(e) => setPastDays(Number(e.target.value))} onBlur={async () => { await ipc.setSetting("calendar_sync_past_days", String(pastDays)); queryClient.invalidateQueries({ queryKey: ["setting", "calendar_sync_past_days"] }); }} className={`${settingsInputClass} h-9 w-16 px-2 py-1.5 text-center`} />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-text-muted whitespace-nowrap">Future days</label>
              <input type="number" min={1} max={365} value={futureDays} onChange={(e) => setFutureDays(Number(e.target.value))} onBlur={async () => { await ipc.setSetting("calendar_sync_future_days", String(futureDays)); queryClient.invalidateQueries({ queryKey: ["setting", "calendar_sync_future_days"] }); }} className={`${settingsInputClass} h-9 w-16 px-2 py-1.5 text-center`} />
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <input type="url" value={icsUrl} onChange={(e) => setIcsUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/..." className={`${settingsInputClass} min-h-10 flex-1`} onKeyDown={(e) => e.key === "Enter" && handleAddIcs()} />
            <button onClick={handleAddIcs} disabled={isAddingIcs || !icsUrl.trim()} className={primarySettingsButtonClass} aria-busy={isAddingIcs}>
              {isAddingIcs ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {isAddingIcs ? "Adding..." : "Add"}
            </button>
          </div>

          {icsUrls.length > 0 && (
            <div className="space-y-1.5">
              {icsUrls.map((url) => {
                let displayUrl = url;
                try {
                  const u = new URL(url);
                  displayUrl = u.hostname + (u.pathname.length > 40 ? u.pathname.slice(0, 40) + "…" : u.pathname);
                } catch { /* keep original */ }
                return (
                  <div key={url} className="flex items-center gap-2 px-3 py-2 bg-bg-tertiary rounded-lg text-sm">
                    <Calendar size={12} className="text-accent shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-text-secondary truncate text-xs">{displayUrl}</p>
                      <p className="text-text-muted text-[10px] truncate">{url}</p>
                    </div>
                    <button onClick={() => handleRemoveIcs(url)} className="text-text-muted hover:text-recording transition-colors shrink-0" aria-label={`Remove calendar feed ${displayUrl}`}><Trash2 size={12} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </SettingsCard>
      </section>
    </div>
  );
}

function CalendarProviderStatus({
  connected,
  credentialsReady,
  error,
  isLoading,
}: {
  connected: boolean;
  credentialsReady: boolean;
  error: unknown;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <SettingsStatusBadge tone="neutral" isLoading>checking</SettingsStatusBadge>;
  }
  if (error) {
    return <SettingsStatusBadge tone="error">check failed</SettingsStatusBadge>;
  }
  if (connected) {
    return <SettingsStatusBadge tone="ok">connected</SettingsStatusBadge>;
  }
  if (credentialsReady) {
    return <SettingsStatusBadge tone="neutral">credentials saved</SettingsStatusBadge>;
  }
  return <SettingsStatusBadge tone="warn">not connected</SettingsStatusBadge>;
}
