import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { format, isToday, isTomorrow, isYesterday, startOfDay, addDays } from "date-fns";
import { Meeting, ipc } from "../../lib/ipc";
import { useUIStore } from "../../stores/uiStore";
import { Mic, FileText } from "lucide-react";

interface AgendaViewProps {
  meetings: Meeting[];
  currentDate: Date;
  emptyState?: ReactNode;
}

function getMeetingDate(m: Meeting): Date | null {
  const raw = m.scheduled_start ?? m.actual_start ?? null;
  if (!raw) return null;
  // Use the date part of the stored string as local midnight to avoid timezone day-shifting
  return new Date(raw.substring(0, 10) + "T00:00:00");
}

function getMeetingDateTime(m: Meeting): Date | null {
  const raw = m.scheduled_start ?? m.actual_start ?? null;
  return raw ? new Date(raw) : null;
}

function getDayLabel(date: Date): string {
  if (isToday(date)) return "Today";
  if (isTomorrow(date)) return "Tomorrow";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "EEEE, MMMM d");
}

function getEventDuration(m: Meeting): string | null {
  if (!m.actual_start || !m.actual_end) return null;
  const mins = Math.round(
    (new Date(m.actual_end).getTime() - new Date(m.actual_start).getTime()) / 60000
  );
  if (mins <= 0) return null;
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ""}`;
}

export function AgendaView({ meetings, currentDate, emptyState }: AgendaViewProps) {
  const navigate = useNavigate();
  const setPendingAutoStart = useUIStore((s) => s.setPendingAutoStart);

  // Group meetings by day, show 60 days centered on currentDate
  const startDate = startOfDay(addDays(currentDate, -7));
  const endDate = startOfDay(addDays(currentDate, 60));

  // Build day groups
  const meetingsWithDates = meetings
    .map((m) => ({ meeting: m, date: getMeetingDate(m) }))
    .filter((x) => x.date !== null && x.date >= startDate && x.date <= endDate)
    .sort((a, b) => a.date!.getTime() - b.date!.getTime());

  // Group by day key
  const dayMap = new Map<string, { date: Date; meetings: Meeting[] }>();
  for (const { meeting, date } of meetingsWithDates) {
    const key = format(date!, "yyyy-MM-dd");
    if (!dayMap.has(key)) {
      dayMap.set(key, { date: startOfDay(date!), meetings: [] });
    }
    dayMap.get(key)!.meetings.push(meeting);
  }

  const days = Array.from(dayMap.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime()
  );

  if (days.length === 0) {
    return emptyState ? <>{emptyState}</> : (
      <div className="flex h-64 flex-col items-center justify-center text-sm text-text-muted">
        No meetings scheduled in this period
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full">
      <div className="max-w-2xl mx-auto px-4 py-4 space-y-6">
        {days.map(({ date, meetings: dayMeetings }) => (
          <div key={format(date, "yyyy-MM-dd")}>
            {/* Day header */}
            <div className="flex items-center gap-3 mb-2">
              <div
                className="flex flex-col items-center justify-center w-10 h-10 rounded-xl shrink-0"
                style={{
                  background: isToday(date)
                    ? "var(--color-accent)"
                    : "var(--glass-search-bg)",
                  border: isToday(date) ? "none" : "1px solid var(--glass-search-border)",
                }}
              >
                <span
                  className="text-footnote font-semibold uppercase leading-none"
                  style={{ color: isToday(date) ? "white" : "var(--color-text-muted)", opacity: isToday(date) ? 1 : 0.7 }}
                >
                  {format(date, "EEE")}
                </span>
                <span
                  className="text-sm font-bold leading-none mt-0.5"
                  style={{ color: isToday(date) ? "white" : "var(--color-text-primary)" }}
                >
                  {format(date, "d")}
                </span>
              </div>
              <div>
                <span className="text-sm font-semibold text-text-primary">
                  {getDayLabel(date)}
                </span>
                {!isToday(date) && !isTomorrow(date) && !isYesterday(date) && (
                  <span className="text-xs text-text-muted ml-2">{format(date, "yyyy")}</span>
                )}
              </div>
            </div>

            {/* Meetings for this day */}
            <div className="ml-[52px] space-y-1.5">
              {dayMeetings.map((m) => {
                const hasRecording = m.actual_start && m.note_status !== "none";
                const duration = getEventDuration(m);
                const isUpcoming = !m.actual_start;

                return (
                  <button
                    key={m.id}
                    onClick={() => navigate({ to: "/meeting/$id", params: { id: m.id } })}
                    className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all hover:border-accent/30"
                    style={{
                      background: "var(--glass-search-bg)",
                      borderColor: "var(--glass-search-border)",
                    }}
                  >
                    {/* Time */}
                    <div className="shrink-0 w-14 text-right">
                      <span className="text-xs text-text-muted">
                        {getMeetingDateTime(m) ? format(getMeetingDateTime(m)!, "h:mm a") : ""}
                      </span>
                    </div>

                    {/* Status dot */}
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        background: hasRecording
                          ? "var(--color-accent)"
                          : isUpcoming
                          ? "var(--color-text-muted)"
                          : "var(--glass-search-border)",
                        opacity: isUpcoming ? 0.5 : 1,
                      }}
                    />

                    {/* Title + meta */}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-text-primary truncate block">{m.title}</span>
                      {duration && (
                        <span className="text-xs text-text-muted">{duration}</span>
                      )}
                    </div>

                    {/* Action icon */}
                    <div className="shrink-0">
                      {hasRecording ? (
                        <FileText size={13} className="text-accent opacity-60" />
                      ) : isUpcoming ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (m.meeting_url) {
                              ipc.openUrl(m.meeting_url).catch(() => {});
                            }
                            setPendingAutoStart(m.id);
                            navigate({ to: "/meeting/$id", params: { id: m.id } });
                          }}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-caption font-medium text-white transition-colors"
                          style={{ background: "var(--color-accent)" }}
                          title={m.meeting_url ? "Open the call link and start recording" : "Record this meeting"}
                        >
                          <Mic size={10} />
                          {m.meeting_url ? "Join & record" : "Record"}
                        </button>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
