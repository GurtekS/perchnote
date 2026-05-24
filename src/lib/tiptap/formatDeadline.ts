// src/lib/tiptap/formatDeadline.ts
import { format, differenceInCalendarDays } from "date-fns";

/**
 * Render a deadline date in a compact way:
 *   - "Tomorrow" if 1 day away
 *   - Weekday name (e.g. "Friday") if 2-7 days away
 *   - Short absolute ("Aug 5") otherwise
 *   - "" for null/invalid
 *
 * ISO strings that carry a UTC offset (e.g. "…Z") are interpreted using their
 * UTC calendar date so results are timezone-independent.
 */
export function formatDeadline(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  let raw: Date;
  try {
    raw = new Date(iso);
  } catch {
    return "";
  }
  if (isNaN(raw.getTime())) return "";

  // Normalise to local midnight using the UTC calendar components so that
  // "2026-08-05T00:00:00Z" is always treated as Aug 5 regardless of the
  // local timezone.
  const d = new Date(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate());

  // Normalise `now` the same way so differenceInCalendarDays is consistent.
  const nowNorm = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const days = differenceInCalendarDays(d, nowNorm);
  if (days === 1) return "Tomorrow";
  if (days >= 2 && days <= 7) return format(d, "EEEE");
  return format(d, "MMM d");
}
