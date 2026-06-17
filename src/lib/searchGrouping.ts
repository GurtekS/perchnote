import type { Meeting, SearchResult } from "./ipc";

/**
 * Pure helpers for the command palette's grouped full-search view
 * (plan v8 A3): `search_all` returns flat per-arm hits ordered by
 * relevance; the palette shows them grouped one-group-per-meeting with
 * the meeting title (and date, when the list cache has it) as header.
 */

export interface SearchResultGroup {
  meetingId: string;
  /** Header title — from the meetings cache, else the title-arm snippet. */
  title: string;
  /** Short date ("Jun 3") when the meetings cache knows this meeting. */
  dateLabel: string | null;
  /** Hits for this meeting, in backend (relevance) order. */
  rows: SearchResult[];
}

/**
 * m:ss for transcript jump rows — same convention as timestampChip /
 * ActionItemView (minutes are not wrapped at 60: 62:05, not 1:02:05).
 */
export function formatMatchTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, "0")}`;
}

/** "Jun 3"-style label for a group header; null when nothing usable. */
export function meetingDateLabel(meeting: Meeting | undefined): string | null {
  const iso =
    meeting?.actual_start ?? meeting?.scheduled_start ?? meeting?.created_at;
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Group flat search hits by meeting. Group order is first-appearance
 * order (i.e. backend relevance); rows keep their arrival order within
 * a group. Search can surface meetings the list cache doesn't carry
 * (e.g. archived) — for those, fall back to the title arm's snippet,
 * which IS the title, then to a placeholder.
 */
export function groupSearchResults(
  results: SearchResult[],
  meetings: Meeting[],
): SearchResultGroup[] {
  const meetingsById = new Map(meetings.map((m) => [m.id, m]));
  const groups = new Map<string, SearchResultGroup>();
  for (const result of results) {
    let group = groups.get(result.meeting_id);
    if (!group) {
      const meeting = meetingsById.get(result.meeting_id);
      const titleHit = results.find(
        (r) => r.meeting_id === result.meeting_id && r.match_source === "title",
      );
      group = {
        meetingId: result.meeting_id,
        title: meeting?.title ?? titleHit?.snippet ?? "Untitled meeting",
        dateLabel: meetingDateLabel(meeting),
        rows: [],
      };
      groups.set(result.meeting_id, group);
    }
    group.rows.push(result);
  }
  return [...groups.values()];
}
