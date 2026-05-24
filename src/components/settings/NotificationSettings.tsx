import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "../../lib/ipc";

const MINUTES_OPTIONS = [
  { value: "1",  label: "1 minute before" },
  { value: "2",  label: "2 minutes before" },
  { value: "5",  label: "5 minutes before" },
  { value: "10", label: "10 minutes before" },
];

const ATTENDEE_OPTIONS = [
  { value: "1", label: "Any meeting (1+ attendees)" },
  { value: "2", label: "2 or more attendees" },
  { value: "3", label: "3 or more attendees" },
];

export function NotificationSettings() {
  const queryClient = useQueryClient();

  const { data: enabledRaw } = useQuery({
    queryKey: ["setting", "notifications_enabled"],
    queryFn: () => ipc.getSetting("notifications_enabled"),
  });
  const { data: minutesRaw } = useQuery({
    queryKey: ["setting", "notification_minutes_before"],
    queryFn: () => ipc.getSetting("notification_minutes_before"),
  });
  const { data: minAttendeesRaw } = useQuery({
    queryKey: ["setting", "notification_min_attendees"],
    queryFn: () => ipc.getSetting("notification_min_attendees"),
  });

  const enabled = enabledRaw !== "false";
  const minutes = minutesRaw ?? "1";
  const minAttendees = minAttendeesRaw ?? "2";

  const set = async (key: string, value: string) => {
    await ipc.setSetting(key, value);
    queryClient.invalidateQueries({ queryKey: ["setting", key] });
  };

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <h2 className="text-base font-semibold text-text-primary mb-0.5">Notifications</h2>
        <p className="text-xs text-text-muted">Get notified before meetings start so you can prepare.</p>
      </div>

      {/* Enable/disable */}
      <section>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Meeting reminders</h3>
            <p className="text-xs text-text-muted mt-0.5">Show a notification before calendar meetings.</p>
          </div>
          <button
            onClick={() => set("notifications_enabled", enabled ? "false" : "true")}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
              enabled ? "bg-accent" : "bg-bg-tertiary border border-border"
            }`}
            role="switch"
            aria-checked={enabled}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transform transition-transform ${
                enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </section>

      {/* Timing */}
      <section className={enabled ? "" : "opacity-40 pointer-events-none"}>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Notify me</h3>
        <p className="text-xs text-text-muted mb-3">How far in advance to send the reminder.</p>
        <div className="grid grid-cols-2 gap-2">
          {MINUTES_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => set("notification_minutes_before", opt.value)}
              className={`px-3 py-2 rounded-lg border text-sm text-left transition-colors ${
                minutes === opt.value
                  ? "border-accent bg-accent/5 text-accent font-medium"
                  : "border-border text-text-secondary hover:bg-bg-tertiary"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      {/* Min attendees */}
      <section className={enabled ? "" : "opacity-40 pointer-events-none"}>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Notify for</h3>
        <p className="text-xs text-text-muted mb-3">Only notify when a meeting has enough attendees.</p>
        <div className="flex flex-col gap-2">
          {ATTENDEE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => set("notification_min_attendees", opt.value)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm text-left transition-colors ${
                minAttendees === opt.value
                  ? "border-accent bg-accent/5 text-accent font-medium"
                  : "border-border text-text-secondary hover:bg-bg-tertiary"
              }`}
            >
              <span
                className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-colors ${
                  minAttendees === opt.value ? "border-accent bg-accent" : "border-border"
                }`}
              />
              {opt.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
