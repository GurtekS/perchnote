import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Meeting } from "../../lib/ipc";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  isSameMonth,
  isToday,
} from "date-fns";

interface MonthViewProps {
  meetings: Meeting[];
  currentDate: Date;
  emptyState?: ReactNode;
}

function getMeetingStart(m: Meeting): Date {
  return new Date((m.scheduled_start ?? m.actual_start)!);
}

function getMeetingDateStr(m: Meeting): string {
  const raw = m.scheduled_start ?? m.actual_start;
  return raw ? raw.substring(0, 10) : "";
}

function hasRecording(m: Meeting): boolean {
  return !!(m.actual_start || m.status === "complete" || m.note_status !== "none");
}

const MAX_PER_DAY = 3;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthView({ meetings, currentDate, emptyState }: MonthViewProps) {
  const navigate = useNavigate();

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 }),
  });
  const currentMonthMeetings = meetings.filter((m) =>
    isSameMonth(getMeetingStart(m), currentDate)
  );

  function handleClick(m: Meeting) {
    if (hasRecording(m)) {
      navigate({ to: "/meeting/$id", params: { id: m.id } });
    } else {
      // Don't auto-start; just open so user can decide
      navigate({ to: "/meeting/$id", params: { id: m.id } });
    }
  }

  if (currentMonthMeetings.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Day name row */}
      <div
        className="shrink-0 grid grid-cols-7"
        style={{ borderBottom: "1px solid var(--glass-header-border)" }}
      >
        {DAY_NAMES.map((d) => (
          <div
            key={d}
            className="py-1.5 text-center text-[10px] font-semibold uppercase tracking-widest text-text-muted"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto">
        <div
          className="grid grid-cols-7"
          style={{ gridAutoRows: "minmax(96px, 1fr)" }}
        >
          {days.map((day) => {
            const dayStr = format(day, "yyyy-MM-dd");
            const dayMeetings = meetings
              .filter((m) => getMeetingDateStr(m) === dayStr)
              .sort((a, b) => getMeetingStart(a).getTime() - getMeetingStart(b).getTime());
            const inMonth = isSameMonth(day, currentDate);
            const overflow = dayMeetings.length - MAX_PER_DAY;

            return (
              <div
                key={day.toISOString()}
                className="p-1.5 relative"
                style={{
                  borderBottom: "1px solid var(--glass-header-border)",
                  borderRight: "1px solid var(--glass-header-border)",
                  opacity: inMonth ? 1 : 0.35,
                }}
              >
                {/* Day number */}
                <div className="flex justify-end mb-1">
                  <span
                    className="w-6 h-6 flex items-center justify-center rounded-full text-[12px] font-semibold"
                    style={
                      isToday(day)
                        ? { background: "var(--accent)", color: "white" }
                        : { color: "var(--color-text-primary)" }
                    }
                  >
                    {format(day, "d")}
                  </span>
                </div>

                {/* Events */}
                <div className="space-y-0.5">
                  {dayMeetings.slice(0, MAX_PER_DAY).map((m) => {
                    const recorded = hasRecording(m);
                    return (
                      <button
                        key={m.id}
                        onClick={() => handleClick(m)}
                        className="w-full flex items-center gap-1 px-1.5 py-0.5 rounded text-left hover:brightness-110 transition-all"
                        style={{
                          background: recorded
                            ? "rgba(var(--accent-rgb), 0.18)"
                            : "rgba(var(--accent-rgb), 0.07)",
                        }}
                      >
                        {recorded && (
                          <div
                            className="w-1 h-1 rounded-full shrink-0"
                            style={{ background: "var(--accent)" }}
                          />
                        )}
                        <span
                          className="text-[10px] font-medium truncate"
                          style={{ color: "var(--accent)" }}
                        >
                          {m.title}
                        </span>
                      </button>
                    );
                  })}
                  {overflow > 0 && (
                    <p className="text-[10px] text-text-muted px-1">
                      +{overflow} more
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
