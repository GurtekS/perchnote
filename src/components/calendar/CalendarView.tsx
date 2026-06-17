import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Meeting, ipc } from "../../lib/ipc";
import { toUserMessage } from "../../lib/errors";
import { AlertCircle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Loader2, RefreshCw, Settings } from "lucide-react";
import {
  format,
  startOfWeek,
  endOfWeek,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
} from "date-fns";
import { WeekView } from "./WeekView";
import { MonthView } from "./MonthView";
import { AgendaView } from "./AgendaView";
import { toast } from "../../stores/toastStore";

type ViewMode = "week" | "month" | "agenda";

export function CalendarView() {
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: rawMeetings } = useQuery<Meeting[]>({
    queryKey: ["meetings"],
    queryFn: () => invoke("list_meetings"),
  });
  const meetings: Meeting[] = Array.isArray(rawMeetings) ? rawMeetings : [];
  const { data: icsUrls = [], error: icsUrlsError, isLoading: icsUrlsLoading } = useQuery<string[]>({
    queryKey: ["ics-urls"],
    queryFn: ipc.listIcsUrls,
    retry: false,
  });
  const { data: isGoogleConnected, error: googleConnectedError, isLoading: googleConnectedLoading } = useQuery({
    queryKey: ["calendar-connected"],
    queryFn: ipc.isGoogleConnected,
    retry: false,
  });
  const { data: isMicrosoftConnected, error: microsoftConnectedError, isLoading: microsoftConnectedLoading } = useQuery({
    queryKey: ["microsoft-connected"],
    queryFn: ipc.isMicrosoftConnected,
    retry: false,
  });
  const isCheckingCalendarStatus = icsUrlsLoading || googleConnectedLoading || microsoftConnectedLoading;
  const calendarStatusError = icsUrlsError || googleConnectedError || microsoftConnectedError;
  const hasCalendarConnection = !!isGoogleConnected || !!isMicrosoftConnected || icsUrls.length > 0;

  // Auto-refresh when background sync completes
  useEffect(() => {
    const unlisten = listen("calendar-synced", () => {
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [queryClient]);

  async function handleSync() {
    setIsSyncing(true);
    setSyncError(null);
    try {
      await ipc.syncIcsCalendars();
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      queryClient.invalidateQueries({ queryKey: ["ics-urls"] });
    } catch (e) {
      const msg = toUserMessage(e, "Couldn't reach the calendar");
      setSyncError(msg);
      toast.error(msg, "Calendar sync failed");
    } finally {
      setIsSyncing(false);
    }
  }

  function handleOpenCalendarSettings() {
    void navigate({ to: "/settings", search: { section: "calendar" } });
  }

  // Only show meetings that have a scheduled or actual date
  const calendarMeetings = meetings.filter(
    (m) => m.scheduled_start || m.actual_start
  );

  const handlePrev = () => {
    if (viewMode === "week") setCurrentDate((d) => subWeeks(d, 1));
    else if (viewMode === "month") setCurrentDate((d) => subMonths(d, 1));
    else setCurrentDate((d) => subWeeks(d, 2));
  };

  const handleNext = () => {
    if (viewMode === "week") setCurrentDate((d) => addWeeks(d, 1));
    else if (viewMode === "month") setCurrentDate((d) => addMonths(d, 1));
    else setCurrentDate((d) => addWeeks(d, 2));
  };

  let headerLabel = "";
  if (viewMode === "week") {
    const ws = startOfWeek(currentDate, { weekStartsOn: 1 });
    const we = endOfWeek(currentDate, { weekStartsOn: 1 });
    headerLabel =
      ws.getMonth() === we.getMonth()
        ? format(ws, "MMMM yyyy")
        : `${format(ws, "MMM")} – ${format(we, "MMM yyyy")}`;
  } else if (viewMode === "month") {
    headerLabel = format(currentDate, "MMMM yyyy");
  } else {
    headerLabel = "Agenda";
  }
  const emptyState = (
    <CalendarEmptyState
      hasCalendarConnection={hasCalendarConnection}
      isCheckingCalendarStatus={isCheckingCalendarStatus}
      isSyncing={isSyncing}
      onConnect={handleOpenCalendarSettings}
      onSync={() => void handleSync()}
      statusError={calendarStatusError}
      syncError={syncError}
      viewMode={viewMode}
    />
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div
        className="shrink-0 flex flex-wrap items-center gap-2 px-5 py-3"
        style={{ borderBottom: "1px solid var(--glass-header-border)" }}
      >
        <span className="min-w-0 flex-1 text-[15px] font-semibold text-text-primary sm:min-w-[160px] sm:flex-none">
          {headerLabel}
        </span>

        <button
          type="button"
          onClick={() => setCurrentDate(new Date())}
          className="px-2.5 py-1 rounded-md text-caption font-medium border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          Today
        </button>
        <button
          type="button"
          onClick={handlePrev}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Previous period"
          aria-label="Previous period"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          onClick={handleNext}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Next period"
          aria-label="Next period"
        >
          <ChevronRight size={15} />
        </button>

        {/* Status reads as information, not a control (UI review #7) —
            it sits with the date context, away from sync/view switches. */}
        <CalendarToolbarStatus
          hasCalendarConnection={hasCalendarConnection}
          isCheckingCalendarStatus={isCheckingCalendarStatus}
          statusError={calendarStatusError}
        />

        <div className="flex-1" />

        {/* Sync button */}
        <button
          type="button"
          onClick={handleSync}
          disabled={isSyncing}
          title={isSyncing ? "Syncing calendar" : "Sync calendar"}
          aria-label={isSyncing ? "Syncing calendar" : "Sync calendar"}
          aria-busy={isSyncing}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-40"
        >
          {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>

        <div className="view-toggle-pill">
          {(["week", "month", "agenda"] as ViewMode[]).map((v) => (
            <button
              type="button"
              key={v}
              onClick={() => setViewMode(v)}
              aria-pressed={viewMode === v}
              className={viewMode === v ? "active" : ""}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {syncError && (
        <div
          role="alert"
          className="mx-5 mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-recording/25 bg-recording/5 px-3 py-2 text-sm text-recording"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="block font-medium">Calendar sync failed</span>
            <span className="mt-0.5 block break-words text-xs leading-5 text-text-secondary">
              {syncError.replace(/^Calendar sync failed:\s*/, "")}
            </span>
          </span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {viewMode === "week" && (
          <WeekView meetings={calendarMeetings} currentDate={currentDate} emptyState={emptyState} />
        )}
        {viewMode === "month" && (
          <MonthView meetings={calendarMeetings} currentDate={currentDate} emptyState={emptyState} />
        )}
        {viewMode === "agenda" && (
          <AgendaView meetings={calendarMeetings} currentDate={currentDate} emptyState={emptyState} />
        )}
      </div>
    </div>
  );
}

function CalendarToolbarStatus({
  hasCalendarConnection,
  isCheckingCalendarStatus,
  statusError,
}: {
  hasCalendarConnection: boolean;
  isCheckingCalendarStatus: boolean;
  statusError: unknown;
}) {
  if (isCheckingCalendarStatus) {
    return (
      <span className="inline-flex min-h-7 items-center gap-1 rounded-full bg-bg-hover px-2 text-caption font-medium text-text-muted">
        <Loader2 size={11} className="animate-spin" />
        Checking
      </span>
    );
  }
  if (statusError) {
    return (
      <span className="inline-flex min-h-7 items-center gap-1 rounded-full bg-recording/10 px-2 text-caption font-medium text-recording">
        <AlertCircle size={11} />
        Status issue
      </span>
    );
  }
  if (hasCalendarConnection) {
    return (
      <span className="inline-flex min-h-7 items-center gap-1 rounded-full bg-accent/10 px-2 text-caption font-medium text-accent">
        <CheckCircle2 size={11} />
        Calendar connected
      </span>
    );
  }
  return (
    <span className="inline-flex min-h-7 items-center gap-1 rounded-full bg-warning/10 px-2 text-caption font-medium text-warning">
      <AlertCircle size={11} />
      No calendar
    </span>
  );
}

function CalendarEmptyState({
  hasCalendarConnection,
  isCheckingCalendarStatus,
  isSyncing,
  onConnect,
  onSync,
  statusError,
  syncError,
  viewMode,
}: {
  hasCalendarConnection: boolean;
  isCheckingCalendarStatus: boolean;
  isSyncing: boolean;
  onConnect: () => void;
  onSync: () => void;
  statusError: unknown;
  syncError: string | null;
  viewMode: ViewMode;
}) {
  const rangeLabel =
    viewMode === "week" ? "this week" : viewMode === "month" ? "this month" : "this agenda range";
  const title = statusError
    ? "Calendar status could not be checked"
    : isCheckingCalendarStatus
      ? "Checking calendar setup"
      : hasCalendarConnection
        ? `No calendar meetings ${rangeLabel}`
        : "Connect a calendar to fill this view";
  const description = statusError
    ? "Open Calendar settings to review connections, or retry sync after the status check recovers."
    : isCheckingCalendarStatus
      ? "Perchnote is checking Google, Microsoft, and ICS calendar setup on this Mac."
      : hasCalendarConnection
        ? "Sync calendars or move to another period. Meetings you record still appear in calendar views once they have dates."
        : "Google, Microsoft, and read-only ICS calendars can add upcoming meetings. Recording still works without calendar setup.";

  return (
    <div className="empty-state h-full px-4 py-12" role={statusError ? "alert" : "status"}>
      <div className="empty-state-icon">
        {isCheckingCalendarStatus ? <Loader2 size={22} className="animate-spin" /> : <CalendarDays size={22} />}
      </div>
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <p className="max-w-md text-sm leading-6 text-text-secondary">{description}</p>
      {syncError && (
        <p className="mt-1 max-w-md text-xs leading-5 text-recording">
          {syncError}
        </p>
      )}
      <div className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onConnect}
          className="btn btn-secondary btn-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <Settings size={14} />
          Open Calendar settings
        </button>
        <button
          type="button"
          onClick={onSync}
          disabled={isSyncing || isCheckingCalendarStatus}
          aria-busy={isSyncing}
          className="btn btn-primary btn-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {isSyncing ? "Syncing calendar…" : "Check for calendar events"}
        </button>
      </div>
    </div>
  );
}
