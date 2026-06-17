import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUIStore } from "../../stores/uiStore";
import { ipc, Meeting } from "../../lib/ipc";
import { toUserMessage } from "../../lib/errors";
import { MeetingStatusBadge } from "../shared/MeetingStatusBadge";
import { Loader2, Mic, Calendar, Clock, ChevronRight, ListChecks } from "lucide-react";
import { format, isToday, isThisWeek } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../../stores/toastStore";

function getMeetingDate(m: Meeting): Date | null {
  const raw = m.scheduled_start ?? m.actual_start ?? m.created_at;
  return raw ? new Date(raw) : null;
}

function isTodayMeeting(m: Meeting): boolean {
  const d = getMeetingDate(m);
  return d ? isToday(d) : false;
}

function formatDuration(m: Meeting): string | null {
  if (!m.actual_start || !m.actual_end) return null;
  const mins = Math.round(
    (new Date(m.actual_end).getTime() - new Date(m.actual_start).getTime()) / 60000
  );
  if (mins <= 0) return null;
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ""}`;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// "Upcoming" means a scheduled future meeting — status alone isn't enough.
// A freshly-created draft (status=upcoming, no scheduled_start) is NOT upcoming.
function isUpcomingStatus(m: Meeting): boolean {
  const hasUpcomingStatus = m.status === "upcoming" || m.status === "scheduled" || m.status === "ready";
  if (!hasUpcomingStatus) return false;
  if (!m.scheduled_start) return false;
  return new Date(m.scheduled_start) >= new Date();
}

export function TodayView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setPendingAutoStart = useUIStore((s) => s.setPendingAutoStart);
  const [isCreating, setIsCreating] = useState(false);

  const { data: meetings = [] } = useQuery<Meeting[]>({
    queryKey: ["meetings"],
    queryFn: () => invoke("list_meetings"),
  });
  const isEmptyAccount = meetings.length === 0;

  const todayMeetings = useMemo(
    () =>
      meetings
        .filter(isTodayMeeting)
        .sort((a, b) => (getMeetingDate(a)?.getTime() ?? 0) - (getMeetingDate(b)?.getTime() ?? 0)),
    [meetings],
  );

  const recentMeetings = useMemo(
    () =>
      meetings
        .filter((m) => !isTodayMeeting(m) && !isUpcomingStatus(m))
        .sort((a, b) => (getMeetingDate(b)?.getTime() ?? 0) - (getMeetingDate(a)?.getTime() ?? 0))
        .slice(0, 5),
    [meetings],
  );

  const thisWeekCount = useMemo(
    () =>
      meetings.filter((m) => {
        const d = getMeetingDate(m);
        return d && isThisWeek(d, { weekStartsOn: 1 }) && m.actual_start;
      }).length,
    [meetings],
  );

  const handleStartRecording = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const dateStr = new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
      }).format(new Date());
      const m = await ipc.createMeeting(`Meeting ${dateStr}`);
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      setPendingAutoStart(m.id);
      navigate({ to: "/meeting/$id", params: { id: m.id } });
    } catch (e) {
      toast.error(toUserMessage(e), "Couldn't create the meeting");
    } finally {
      setIsCreating(false);
    }
  };
  const startRecordingLabel = isCreating
    ? (isEmptyAccount ? "Creating first meeting…" : "Creating meeting…")
    : (isEmptyAccount ? "Start First Recording" : "Start Recording");

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-xl mx-auto px-6 py-10 space-y-8 animate-fade-in">

        {/* Greeting + date — display moment, not body copy */}
        <div className="space-y-1">
          <p
            className="flex items-center gap-1.5 text-footnote font-semibold uppercase tracking-[0.14em]"
            style={{ color: "var(--meeting-meta-color)" }}
          >
            <span
              className="inline-block h-[5px] w-[5px] rounded-full dot-glow"
              style={{ background: "var(--color-accent)", color: "var(--color-accent)" }}
            />
            {getGreeting()}
          </p>
          <p className="text-[30px] font-bold tracking-[-0.03em] text-text-primary leading-tight">
            {format(new Date(), "EEEE, MMMM d")}
          </p>
        </div>

        {/* Record CTA */}
        <button
          onClick={handleStartRecording}
          disabled={isCreating}
          aria-busy={isCreating}
          className="enhance-glow w-full flex items-center justify-center gap-2.5 py-3.5 rounded-2xl text-[15px] font-semibold text-white transition-all hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
        >
          {isCreating ? <Loader2 size={18} className="animate-spin" /> : <Mic size={17} />}
          {startRecordingLabel}
        </button>

        {/* Today's meetings */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Calendar size={12} style={{ color: "var(--section-label-color)" }} />
            <span
              className="text-footnote font-semibold uppercase tracking-[0.08em]"
              style={{ color: "var(--section-label-color)" }}
            >
              Today
            </span>
            <div className="flex-1 kicker-rule" />
            {thisWeekCount > 0 && (
              <span className="text-caption" style={{ color: "var(--meeting-meta-color)" }}>
                {thisWeekCount} recorded this week
              </span>
            )}
          </div>

          {todayMeetings.length === 0 ? (
            <div
              className="rounded-xl px-4 py-5 text-center"
              style={{
                background: "var(--glass-search-bg)",
                border: "1px solid var(--glass-header-border)",
              }}
            >
              <p className="text-body-sm text-text-secondary">
                {isEmptyAccount ? "Start your first meeting" : "No meetings scheduled today"}
              </p>
              <p className="text-caption mt-1" style={{ color: "var(--meeting-meta-color)" }}>
                {isEmptyAccount
                  ? "Record now without connecting calendar or AI. Setup can be changed later from Settings."
                  : "Use Start Recording above to capture an ad hoc meeting, or sync your calendar."}
              </p>
              {isEmptyAccount && (
                <div className="mt-4 flex flex-col items-stretch justify-center gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={handleStartRecording}
                    disabled={isCreating}
                    aria-busy={isCreating}
                    className="btn btn-primary btn-lg disabled:cursor-wait"
                  >
                    {isCreating ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
                    {isCreating ? startRecordingLabel : "Record a meeting now"}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate({ to: "/settings", search: { section: "setup" } })}
                    className="btn btn-secondary btn-lg"
                  >
                    <ListChecks size={14} />
                    Open setup guide
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {todayMeetings.map((m) => {
                const upcoming = isUpcomingStatus(m);
                const d = getMeetingDate(m);
                const duration = formatDuration(m);
                return (
                  <button
                    key={m.id}
                    onClick={() => navigate({ to: "/meeting/$id", params: { id: m.id } })}
                    className={`w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left transition-all hover:-translate-y-px hover:brightness-110 ${upcoming ? "" : "card"}`}
                    style={{
                      ...(upcoming
                        ? {
                            background: "rgba(var(--accent-rgb), 0.08)",
                            border: "1px solid rgba(var(--accent-rgb), 0.22)",
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
                          }
                        : {}),
                    }}
                  >
                    {/* Time */}
                    <div className="shrink-0 w-16 text-right">
                      {d && (
                        <span
                          className="text-caption font-medium tabular-nums whitespace-nowrap"
                          style={{ color: upcoming ? "var(--color-accent)" : "var(--meeting-meta-color)" }}
                        >
                          {format(d, "h:mm a")}
                        </span>
                      )}
                    </div>
                    {/* Divider */}
                    <div
                      className="w-px h-6 shrink-0"
                      style={{
                        background: upcoming
                          ? "rgba(var(--accent-rgb), 0.25)"
                          : "var(--glass-header-border)",
                      }}
                    />
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <span className="text-body-sm font-medium text-text-primary truncate block leading-tight">
                        {m.title}
                      </span>
                      {duration && (
                        <span className="text-caption" style={{ color: "var(--meeting-meta-color)" }}>
                          {duration}
                        </span>
                      )}
                    </div>
                    {/* Badge */}
                    {upcoming ? (
                      <span
                        className="shrink-0 text-footnote font-semibold px-2 py-0.5 rounded-full"
                        style={{
                          background: "rgba(var(--accent-rgb), 0.15)",
                          color: "var(--color-accent)",
                        }}
                      >
                        Upcoming
                      </span>
                    ) : (
                      <MeetingStatusBadge status={m.note_status ?? "none"} />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent recordings */}
        {recentMeetings.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Clock size={12} style={{ color: "var(--section-label-color)" }} />
              <span
                className="text-footnote font-semibold uppercase tracking-[0.08em]"
                style={{ color: "var(--section-label-color)" }}
              >
                Recent
              </span>
              <div className="flex-1 kicker-rule" />
            </div>
            <div className="ios-group">
              {recentMeetings.map((m) => {
                const d = getMeetingDate(m);
                const duration = formatDuration(m);
                return (
                  <button
                    key={m.id}
                    onClick={() => navigate({ to: "/meeting/$id", params: { id: m.id } })}
                    className="ios-row"
                  >
                    <span className="flex-1 text-sm text-text-primary truncate">{m.title}</span>
                    {duration && (
                      <span className="text-caption shrink-0" style={{ color: "var(--meeting-meta-color)" }}>
                        {duration}
                      </span>
                    )}
                    <span className="text-caption shrink-0" style={{ color: "var(--meeting-meta-color)" }}>
                      {d ? format(d, "MMM d") : ""}
                    </span>
                    <MeetingStatusBadge status={m.note_status ?? "none"} />
                  </button>
                );
              })}
              <button
                onClick={() => navigate({ to: "/meetings" })}
                className="w-full flex items-center justify-center gap-1 px-3 py-2 text-caption rounded-lg transition-colors hover:bg-bg-hover"
                style={{ color: "var(--meeting-meta-color)" }}
              >
                All meetings
                <ChevronRight size={12} />
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
