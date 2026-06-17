// src/components/meeting/MetadataStrip.tsx
import { useState } from "react";
import type { ReactNode } from "react";
import { CalendarDays, Check, Clock3, MapPin, Pencil, Users, X } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ipc, Meeting, openLocation } from "../../lib/ipc";

interface Props {
  meeting: Meeting;
  onSaved: () => void;
}

function parseAttendeeNames(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((a: unknown) => {
        if (typeof a === "string") return a.split("@")[0];
        if (typeof a === "object" && a !== null) {
          const o = a as Record<string, string>;
          return o.name || o.email?.split("@")[0] || "";
        }
        return "";
      })
      .filter(Boolean);
  } catch { return []; }
}

function toDatetimeLocal(iso: string): string {
  try {
    const d = parseISO(iso);
    return format(d, "yyyy-MM-dd'T'HH:mm");
  } catch { return ""; }
}

export function MetadataStrip({ meeting, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [location, setLocation] = useState("");
  const [attendeesRaw, setAttendeesRaw] = useState("");
  const [saving, setSaving] = useState(false);

  function openEdit() {
    const s = meeting.scheduled_start || meeting.actual_start || "";
    const e = meeting.scheduled_end || meeting.actual_end || "";
    setStart(s ? toDatetimeLocal(s) : "");
    setEnd(e ? toDatetimeLocal(e) : "");
    setLocation(meeting.location || "");
    setAttendeesRaw(parseAttendeeNames(meeting.attendees).join(", "));
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      const toISO = (v: string) => (v ? new Date(v).toISOString() : null);
      const attendeesJson = attendeesRaw.trim()
        ? JSON.stringify(attendeesRaw.split(",").map((s) => s.trim()).filter(Boolean))
        : null;
      await ipc.updateMeetingMetadata(meeting.id, {
        scheduledStart: toISO(start),
        scheduledEnd: toISO(end),
        location: location.trim() || null,
        attendees: attendeesJson,
      });
      onSaved();
      setEditing(false);
    } catch { /* ignored */ } finally {
      setSaving(false);
    }
  }

  const dateStr = meeting.scheduled_start || meeting.actual_start || meeting.created_at;
  // Duration pairs like with like (whole-app review P3): scheduled_start +
  // actual_end produced "5h 35m" for a calendar event recorded later.
  const durationPair: [string, string] | null =
    meeting.actual_start && meeting.actual_end
      ? [meeting.actual_start, meeting.actual_end]
      : meeting.scheduled_start && meeting.scheduled_end
      ? [meeting.scheduled_start, meeting.scheduled_end]
      : null;
  const date = dateStr ? format(new Date(dateStr), "EEE, MMM d, yyyy 'at' h:mm a") : null;
  let duration: string | null = null;
  if (durationPair) {
    const mins = Math.round(
      (new Date(durationPair[1]).getTime() - new Date(durationPair[0]).getTime()) / 60000,
    );
    if (mins > 0) duration = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ""}`;
  }
  const attendees = parseAttendeeNames(meeting.attendees);
  const attendeesStr = attendees.length > 4
    ? `${attendees.slice(0, 4).join(", ")} +${attendees.length - 4}`
    : attendees.join(", ");

  if (editing) {
    return (
      <div className="mb-5 space-y-3 card p-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-footnote font-medium text-text-muted uppercase tracking-wider">Start</span>
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)}
              className="h-8 rounded-md border border-border bg-bg-secondary px-2 text-caption text-text-primary focus:outline-none focus:border-accent" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-footnote font-medium text-text-muted uppercase tracking-wider">End</span>
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)}
              className="h-8 rounded-md border border-border bg-bg-secondary px-2 text-caption text-text-primary focus:outline-none focus:border-accent" />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-footnote font-medium text-text-muted uppercase tracking-wider">Location / URL</span>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)}
            placeholder="Address or meeting URL"
            className="h-8 rounded-md border border-border bg-bg-secondary px-2 text-caption text-text-primary placeholder-text-muted/50 focus:outline-none focus:border-accent" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-footnote font-medium text-text-muted uppercase tracking-wider">Attendees (comma-separated)</span>
          <input type="text" value={attendeesRaw} onChange={(e) => setAttendeesRaw(e.target.value)}
            placeholder="Alice, Bob, Carol"
            className="h-8 rounded-md border border-border bg-bg-secondary px-2 text-caption text-text-primary placeholder-text-muted/50 focus:outline-none focus:border-accent" />
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={save} disabled={saving}
            className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs text-white transition-colors hover:bg-accent-hover disabled:opacity-50">
            <Check size={11} /> Save
          </button>
          <button type="button" onClick={() => setEditing(false)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
            <X size={11} /> Cancel
          </button>
        </div>
      </div>
    );
  }

  // Display mode is ONE quiet line, not a card (UI review #1: the meeting
  // view stacked five chrome layers and repeated the date three times
  // before any notes). Edit mode keeps its full card below.
  return (
    <section
      className="mb-1.5 flex items-center gap-3 px-1 text-caption text-text-muted"
      aria-label="Meeting details"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        <div className="contents">
          <MetadataItem icon={<CalendarDays size={13} />} label="Date">
            <span className={date ? "" : "italic"}>{date || "No date set"}</span>
          </MetadataItem>
          {duration && (
            <MetadataItem icon={<Clock3 size={13} />} label="Duration">
              {duration}
            </MetadataItem>
          )}
          {attendeesStr && (
            <MetadataItem icon={<Users size={13} />} label="Attendees">
              <span className="truncate">{attendeesStr}</span>
            </MetadataItem>
          )}
          {meeting.location && (
            <MetadataItem icon={<MapPin size={13} />} label="Location">
              <button
                type="button"
                onClick={() => openLocation(meeting.location!)}
                className="min-w-0 truncate rounded text-left text-accent/80 transition-colors hover:text-accent"
                title="Open location"
                aria-label={`Open location ${meeting.location}`}
              >
                {meeting.location}
              </button>
            </MetadataItem>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={openEdit}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        title="Edit meeting details"
        aria-label="Edit meeting details"
      >
        <Pencil size={11} />
      </button>
    </section>
  );
}

function MetadataItem({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-text-muted/70">{icon}</span>
      <span className="sr-only">{label}: </span>
      <span className="min-w-0 truncate leading-5">{children}</span>
    </div>
  );
}
