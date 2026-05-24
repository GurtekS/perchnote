import { useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Meeting } from "../../lib/ipc";
import { useUIStore } from "../../stores/uiStore";
import {
  startOfWeek,
  addDays,
  format,
  isToday,
} from "date-fns";

const FIRST_HOUR = 7;
const LAST_HOUR = 21;
const VISIBLE_HOURS = LAST_HOUR - FIRST_HOUR;
const HOUR_PX = 56;

interface WeekViewProps {
  meetings: Meeting[];
  currentDate: Date;
  emptyState?: ReactNode;
}

function getMeetingStart(m: Meeting): Date {
  return new Date((m.scheduled_start ?? m.actual_start)!);
}

/** Extract YYYY-MM-DD from stored ISO string to avoid timezone-shift for day bucketing */
function getMeetingDateStr(m: Meeting): string {
  const raw = m.scheduled_start ?? m.actual_start;
  return raw ? raw.substring(0, 10) : "";
}

function getMeetingEnd(m: Meeting): Date {
  if (m.scheduled_end) return new Date(m.scheduled_end);
  if (m.actual_end) return new Date(m.actual_end);
  const s = getMeetingStart(m);
  return new Date(s.getTime() + 60 * 60 * 1000);
}

function hasRecording(m: Meeting): boolean {
  return !!(m.actual_start || m.status === "complete" || m.note_status !== "none");
}

function eventStyle(m: Meeting): React.CSSProperties {
  const s = getMeetingStart(m);
  const e = getMeetingEnd(m);
  const startMin = s.getHours() * 60 + s.getMinutes();
  const endMin = e.getHours() * 60 + e.getMinutes();
  const topMin = Math.max(startMin - FIRST_HOUR * 60, 0);
  const durMin = Math.min(
    Math.max(endMin - startMin, 30),
    VISIBLE_HOURS * 60 - topMin
  );
  return {
    top: `${(topMin / 60) * HOUR_PX}px`,
    height: `${Math.max((durMin / 60) * HOUR_PX, 22)}px`,
  };
}

export function WeekView({ meetings, currentDate, emptyState }: WeekViewProps) {
  const navigate = useNavigate();
  const setPendingAutoStart = useUIStore((s) => s.setPendingAutoStart);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<{
    meeting: Meeting;
    x: number;
    y: number;
  } | null>(null);

  // Scroll to 8am on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = (8 - FIRST_HOUR) * HOUR_PX - 8;
    }
  }, []);

  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const hours = Array.from({ length: VISIBLE_HOURS }, (_, i) => FIRST_HOUR + i);
  const meetingsByDay = days.map((day) => {
    const dayStr = format(day, "yyyy-MM-dd");
    return {
      day,
      meetings: meetings.filter((m) => getMeetingDateStr(m) === dayStr),
    };
  });
  const visibleMeetingCount = meetingsByDay.reduce((count, day) => count + day.meetings.length, 0);

  function handleEventClick(e: React.MouseEvent, meeting: Meeting) {
    e.stopPropagation();
    if (hasRecording(meeting)) {
      navigate({ to: "/meeting/$id", params: { id: meeting.id } });
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cr = containerRef.current!.getBoundingClientRect();
    setPopover({
      meeting,
      x: Math.min(rect.left - cr.left, cr.width - 272),
      y: rect.bottom - cr.top + 6,
    });
  }

  function handleRecord(id: string) {
    setPopover(null);
    setPendingAutoStart(true);
    navigate({ to: "/meeting/$id", params: { id } });
  }

  function handleOpen(id: string) {
    setPopover(null);
    navigate({ to: "/meeting/$id", params: { id } });
  }

  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  if (visibleMeetingCount === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <>
      <div className="h-full overflow-y-auto px-3 py-3 sm:hidden">
        <div className="space-y-3">
          {meetingsByDay.map(({ day, meetings: dayMeetings }) => (
            <section key={day.toISOString()} className="rounded-lg border border-border bg-bg-secondary p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {isToday(day) ? "Today" : format(day, "EEEE")}
                  </h3>
                  <p className="text-xs text-text-muted">{format(day, "MMM d")}</p>
                </div>
                <span className="shrink-0 rounded-full bg-bg-hover px-2 py-1 text-[11px] font-medium text-text-muted">
                  {dayMeetings.length} {dayMeetings.length === 1 ? "meeting" : "meetings"}
                </span>
              </div>
              {dayMeetings.length === 0 ? (
                <p className="rounded-lg border border-border/70 bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
                  No meetings scheduled.
                </p>
              ) : (
                <div className="space-y-2">
                  {dayMeetings
                    .sort((a, b) => getMeetingStart(a).getTime() - getMeetingStart(b).getTime())
                    .map((meeting) => {
                      const recorded = hasRecording(meeting);
                      return (
                        <div
                          key={meeting.id}
                          className="rounded-lg border border-border bg-bg-tertiary p-3"
                        >
                          <div className="flex items-start gap-3">
                            <span
                              className="mt-1 h-2 w-2 shrink-0 rounded-full"
                              style={{
                                background: recorded ? "var(--accent)" : "var(--color-text-muted)",
                                opacity: recorded ? 1 : 0.55,
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-text-primary">{meeting.title}</p>
                              <p className="mt-0.5 text-xs text-text-muted">
                                {format(getMeetingStart(meeting), "h:mm a")}
                                {meeting.scheduled_end && ` - ${format(new Date(meeting.scheduled_end), "h:mm a")}`}
                              </p>
                            </div>
                          </div>
                          <div className="mt-3 flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleOpen(meeting.id)}
                              className="inline-flex min-h-9 flex-1 items-center justify-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                            >
                              Open
                            </button>
                            {!recorded && (
                              <button
                                type="button"
                                onClick={() => handleRecord(meeting.id)}
                                className="inline-flex min-h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-recording px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-recording/90"
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-white" />
                                Record
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative hidden h-full flex-col sm:flex"
        onClick={() => setPopover(null)}
      >
      {/* Day headers */}
      <div
        className="shrink-0 flex"
        style={{
          paddingLeft: "48px",
          borderBottom: "1px solid var(--glass-header-border)",
        }}
      >
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className="flex-1 flex flex-col items-center py-1.5 gap-0.5"
          >
            <span className="text-[10px] font-medium uppercase tracking-widest text-text-muted">
              {format(day, "EEE")}
            </span>
            <span
              className="w-7 h-7 flex items-center justify-center rounded-full text-[13px] font-semibold"
              style={
                isToday(day)
                  ? { background: "var(--accent)", color: "white" }
                  : { color: "var(--color-text-primary)" }
              }
            >
              {format(day, "d")}
            </span>
          </div>
        ))}
      </div>

      {/* Scrollable grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex" style={{ minHeight: `${VISIBLE_HOURS * HOUR_PX}px` }}>
          {/* Hour labels */}
          <div className="w-12 shrink-0 relative select-none">
            {hours.map((h) => (
              <div
                key={h}
                className="absolute right-2 text-[10px] font-medium text-text-muted"
                style={{ top: `${(h - FIRST_HOUR) * HOUR_PX - 7}px` }}
              >
                {h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {meetingsByDay.map(({ day, meetings: dayMeetings }) => {
            const todayLine =
              isToday(day) &&
              nowMinutes >= FIRST_HOUR * 60 &&
              nowMinutes <= LAST_HOUR * 60;

            return (
              <div
                key={day.toISOString()}
                className="flex-1 relative"
                style={{
                  minHeight: `${VISIBLE_HOURS * HOUR_PX}px`,
                  borderLeft: "1px solid var(--glass-header-border)",
                }}
              >
                {/* Hour lines */}
                {hours.map((h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0"
                    style={{
                      top: `${(h - FIRST_HOUR) * HOUR_PX}px`,
                      borderTop: "1px solid var(--glass-header-border)",
                    }}
                  />
                ))}
                {/* Half-hour lines */}
                {hours.map((h) => (
                  <div
                    key={`h${h}`}
                    className="absolute inset-x-0"
                    style={{
                      top: `${(h - FIRST_HOUR) * HOUR_PX + HOUR_PX / 2}px`,
                      borderTop: "1px solid rgba(var(--accent-rgb),0.06)",
                    }}
                  />
                ))}

                {/* Now indicator */}
                {todayLine && (
                  <div
                    className="absolute inset-x-0 z-20 flex items-center pointer-events-none"
                    style={{
                      top: `${((nowMinutes - FIRST_HOUR * 60) / 60) * HOUR_PX}px`,
                    }}
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0 -ml-1"
                      style={{ background: "var(--accent)" }}
                    />
                    <div
                      className="flex-1 h-px"
                      style={{ background: "var(--accent)" }}
                    />
                  </div>
                )}

                {/* Events */}
                {dayMeetings.map((m) => {
                  const recorded = hasRecording(m);
                  return (
                    <div
                      key={m.id}
                      onClick={(e) => handleEventClick(e, m)}
                      className="absolute rounded-md px-1.5 py-0.5 cursor-pointer overflow-hidden z-10 transition-all hover:brightness-110"
                      style={{
                        ...eventStyle(m),
                        left: "2px",
                        right: "2px",
                        background: recorded
                          ? "rgba(var(--accent-rgb), 0.22)"
                          : "rgba(var(--accent-rgb), 0.09)",
                        border: `1px solid rgba(var(--accent-rgb), ${recorded ? 0.45 : 0.22})`,
                      }}
                    >
                      <div className="flex items-start gap-1 min-w-0 h-full">
                        {recorded && (
                          <div
                            className="w-1.5 h-1.5 rounded-full shrink-0 mt-[3px]"
                            style={{ background: "var(--accent)" }}
                          />
                        )}
                        <div className="min-w-0">
                          <p
                            className="text-[11px] font-medium leading-tight truncate"
                            style={{ color: "var(--accent)" }}
                          >
                            {m.title}
                          </p>
                          <p className="text-[10px] leading-tight" style={{ color: "rgba(var(--accent-rgb),0.6)" }}>
                            {format(getMeetingStart(m), "h:mm a")}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Event popover */}
      {popover && (
        <div
          className="absolute z-50 w-64 rounded-xl shadow-xl p-3 space-y-2.5"
          style={{
            left: `${popover.x}px`,
            top: `${popover.y}px`,
            background: "var(--popup-bg)",
            border: "1px solid var(--popup-border)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div>
            <p className="text-[13px] font-semibold text-text-primary leading-snug">
              {popover.meeting.title}
            </p>
            <p className="text-[11px] text-text-muted mt-0.5">
              {format(getMeetingStart(popover.meeting), "EEE, MMM d · h:mm a")}
              {popover.meeting.scheduled_end &&
                ` – ${format(new Date(popover.meeting.scheduled_end), "h:mm a")}`}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleRecord(popover.meeting.id)}
              className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors"
              style={{ background: "var(--color-recording)" }}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-white shrink-0" />
              Record
            </button>
            <button
              onClick={() => handleOpen(popover.meeting.id)}
              className="flex-1 px-2.5 py-1.5 rounded-lg text-xs text-text-secondary border border-border hover:text-text-primary hover:bg-bg-hover transition-colors text-center"
            >
              Open
            </button>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
