import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CalendarCheck2 } from "lucide-react";
import { ActionItem, Meeting } from "../../lib/ipc";
import { ageWeeks, isSnoozed } from "./TasksView";

/** Monday-of-week (ISO date) for a given date string. */
export function weekStart(today: string): string {
  // Local-midnight parse + LOCAL-noon render: toISOString on a local
  // midnight is yesterday in any UTC+ timezone, so "Monday" came back as
  // Sunday's date for IST/CET users (whole-app review P3).
  const d = new Date(today + "T12:00:00");
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

/** [start, end) ISO range of the week BEFORE the one containing `today`. */
export function lastWeekRange(today: string): [string, string] {
  const thisMonday = weekStart(today);
  const prev = new Date(thisMonday + "T12:00:00"); // noon: ISO-safe in UTC+
  prev.setDate(prev.getDate() - 7);
  return [prev.toISOString().slice(0, 10), thisMonday];
}

interface Props {
  items: ActionItem[];
  meetings: Meeting[];
  today: string;
  onReviewStale: () => void;
}

/** Week in review (plan v5 rank 5): what happened, what's still open by
 *  age, what's due next — assembled from data already on this Mac. */
export function WeekReviewCard({ items, meetings, today, onReviewStale }: Props) {
  const navigate = useNavigate();
  const [lwStart, lwEnd] = lastWeekRange(today);

  const lastWeekMeetings = useMemo(
    () =>
      meetings.filter((m) => {
        const d = (m.actual_start ?? m.scheduled_start ?? m.created_at).slice(0, 10);
        return d >= lwStart && d < lwEnd && m.status === "complete";
      }),
    [meetings, lwStart, lwEnd],
  );

  const doneFromLastWeek = useMemo(
    () =>
      items.filter(
        (i) =>
          i.done &&
          i.meeting_date &&
          i.meeting_date.slice(0, 10) >= lwStart &&
          i.meeting_date.slice(0, 10) < lwEnd,
      ).length,
    [items, lwStart, lwEnd],
  );

  const open = useMemo(
    () => items.filter((i) => !i.done && !i.dropped && !isSnoozed(i, today)),
    [items, today],
  );
  const openRecent = open.filter((i) => (ageWeeks(i.meeting_date, today) ?? 0) < 1).length;
  const openMid = open.filter((i) => {
    const w = ageWeeks(i.meeting_date, today) ?? 0;
    return w >= 1 && w < 2;
  }).length;
  const openStale = open.filter((i) => (ageWeeks(i.meeting_date, today) ?? 0) >= 2).length;

  const weekOut = new Date(new Date(today).getTime() + 7 * 86400_000).toISOString().slice(0, 10);
  const dueSoon = useMemo(
    () =>
      open
        .filter((i) => i.deadline && i.deadline.slice(0, 10) >= today && i.deadline.slice(0, 10) <= weekOut)
        .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? "")),
    [open, today, weekOut],
  );

  return (
    <div className="mb-4 card p-4">
      <p className="section-label mb-3 flex items-center gap-1.5">
        <CalendarCheck2 size={11} />
        Week in review
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="m-0 text-2xl font-semibold text-text-primary">
            {lastWeekMeetings.length}
          </p>
          <p className="m-0 text-xs text-text-muted">
            meeting{lastWeekMeetings.length === 1 ? "" : "s"} last week
            {doneFromLastWeek > 0 && ` · ${doneFromLastWeek} task${doneFromLastWeek === 1 ? "" : "s"} from them done`}
          </p>
          {lastWeekMeetings.slice(0, 4).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => navigate({ to: "/meeting/$id", params: { id: m.id } })}
              className="mt-1 block max-w-full truncate text-left text-xs text-accent hover:underline"
            >
              {m.title}
            </button>
          ))}
        </div>

        <div>
          <p className="m-0 text-2xl font-semibold text-text-primary">{open.length}</p>
          <p className="m-0 text-xs text-text-muted">open items by age</p>
          <p className="mt-1 text-xs text-text-secondary">
            {openRecent} this week · {openMid} last week ·{" "}
            {openStale > 0 ? (
              <button
                type="button"
                onClick={onReviewStale}
                className="text-amber-500 hover:underline"
              >
                {openStale} older, review
              </button>
            ) : (
              "0 older"
            )}
          </p>
        </div>

        <div>
          <p className="m-0 text-2xl font-semibold text-text-primary">{dueSoon.length}</p>
          <p className="m-0 text-xs text-text-muted">due in the next 7 days</p>
          {dueSoon.slice(0, 4).map((i) => (
            <p key={`${i.note_id}:${i.source}:${i.index}`} className="m-0 mt-1 truncate text-xs text-text-secondary">
              <span className="text-text-muted">{i.deadline?.slice(5, 10)}</span> {i.task}
              {i.assignee?.trim() ? ` (${i.assignee.trim()})` : ""}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
