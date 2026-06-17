import { ActionItem, Meeting, TopicTrend } from "../../lib/ipc";
import { weekStart } from "../tasks/WeekReviewCard";
import { ageWeeks, isSnoozed } from "../tasks/TasksView";

/** A meeting's date for bucketing: when it actually ran, else when it was due to. */
function meetingDate(m: Meeting): string | null {
  return m.actual_start ?? m.scheduled_start ?? m.created_at ?? null;
}

/** Duration in hours; actual span preferred, scheduled span as fallback.
 *  Spans that are nonpositive or implausibly long (>8h — header-repair
 *  leftovers) count as zero rather than skewing a whole week. */
function meetingHours(m: Meeting): number {
  const span = (a?: string | null, b?: string | null) => {
    if (!a || !b) return 0;
    const h = (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
    return h > 0 && h <= 8 ? h : 0;
  };
  return span(m.actual_start, m.actual_end) || span(m.scheduled_start, m.scheduled_end);
}

export interface WeekLoad {
  weekStart: string; // Monday, ISO date
  hours: number;
  count: number;
}

/** Hours + meeting count per ISO week (Mon-start), oldest first, exactly
 *  `weeks` entries ending with the week containing `today`. Only meetings
 *  that actually happened (complete) count toward load. */
export function weeklyLoad(meetings: Meeting[], today: string, weeks = 12): WeekLoad[] {
  const out: WeekLoad[] = [];
  const thisMonday = weekStart(today);
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisMonday + "T00:00:00");
    d.setDate(d.getDate() - 7 * i);
    out.push({ weekStart: d.toISOString().slice(0, 10), hours: 0, count: 0 });
  }
  const first = out[0].weekStart;
  for (const m of meetings) {
    if (m.status !== "complete") continue;
    const date = meetingDate(m);
    if (!date) continue;
    const wk = weekStart(date.slice(0, 10));
    if (wk < first) continue;
    const bucket = out.find((w) => w.weekStart === wk);
    if (!bucket) continue;
    bucket.hours += meetingHours(m);
    bucket.count += 1;
  }
  for (const w of out) w.hours = Math.round(w.hours * 10) / 10;
  return out;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const fmtHours = (h: number) =>
  h >= 10 ? `${Math.round(h)} hours` : `${Math.round(h * 10) / 10} hours`;

/** Headline that answers "is that good?" against the user's own median.
 *  `weeks` from weeklyLoad (last entry = current week). */
export function loadHeadline(weeks: WeekLoad[]): string {
  const current = weeks[weeks.length - 1];
  if (!current) return "";
  const prior = weeks.slice(0, -1).filter((w) => w.count > 0);
  if (prior.length < 2) {
    return current.count === 0
      ? "No meetings recorded this week yet."
      : `${fmtHours(current.hours)} in ${current.count} meeting${current.count === 1 ? "" : "s"} this week.`;
  }
  const typical = median(prior.map((w) => w.hours));
  const diff = current.hours - typical;
  const base = `${fmtHours(current.hours)} in meetings this week`;
  if (Math.abs(diff) < Math.max(0.5, typical * 0.15)) {
    return `${base}, about your typical week (${fmtHours(typical)}).`;
  }
  return diff > 0
    ? `${base}, ${fmtHours(diff)} more than your typical ${fmtHours(typical)}.`
    : `${base}, ${fmtHours(-diff)} lighter than your typical ${fmtHours(typical)}.`;
}

/** Meetings-by-start-hour over the trailing `days`; local time. */
export function hourHistogram(meetings: Meeting[], today: string, days = 90): number[] {
  const hist = new Array<number>(24).fill(0);
  const cutoff = new Date(new Date(today + "T00:00:00").getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const m of meetings) {
    if (m.status !== "complete") continue;
    const date = meetingDate(m);
    if (!date || date.slice(0, 10) < cutoff) continue;
    hist[new Date(date).getHours()] += 1;
  }
  return hist;
}

/** "Most meetings start between 10 AM and noon." — best 2-hour window. */
export function peakWindowSentence(hist: number[]): string | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total < 5) return null; // too little data to claim a pattern
  let best = 0;
  let bestStart = 0;
  for (let h = 0; h < 23; h++) {
    const sum = hist[h] + hist[h + 1];
    if (sum > best) {
      best = sum;
      bestStart = h;
    }
  }
  if (best === 0) return null;
  const label = (h: number) =>
    h === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h} AM` : `${h - 12} PM`;
  return `Most of your meetings start between ${label(bestStart)} and ${label(bestStart + 2)}.`;
}

export interface OpenLoopFacts {
  open: number;
  meetings: number;
  oldestWeeks: number;
  /** Done items from meetings held in the last 7 days — honest framing,
   *  since items have no completed-at timestamp. */
  closedFromRecent: number;
  staleCount: number;
}

export function openLoopFacts(items: ActionItem[], today: string): OpenLoopFacts {
  const open = items.filter((i) => !i.done && !i.dropped && !isSnoozed(i, today));
  const weekAgo = new Date(new Date(today + "T00:00:00").getTime() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    open: open.length,
    meetings: new Set(open.map((i) => i.meeting_id)).size,
    oldestWeeks: open.reduce((mx, i) => Math.max(mx, ageWeeks(i.meeting_date, today) ?? 0), 0),
    closedFromRecent: items.filter(
      (i) => i.done && i.meeting_date && i.meeting_date.slice(0, 10) >= weekAgo,
    ).length,
    staleCount: open.filter((i) => (ageWeeks(i.meeting_date, today) ?? 0) >= 2).length,
  };
}

/** Agency-framed (never a score): what's open, what moved, where to act. */
export function openLoopHeadline(f: OpenLoopFacts): string {
  if (f.open === 0) {
    return f.closedFromRecent > 0
      ? `All caught up. ${f.closedFromRecent} item${f.closedFromRecent === 1 ? "" : "s"} from this week's meetings already done.`
      : "All caught up. No open action items.";
  }
  const parts = [
    `${f.open} open item${f.open === 1 ? "" : "s"} across ${f.meetings} meeting${f.meetings === 1 ? "" : "s"}`,
  ];
  if (f.oldestWeeks >= 2) parts.push(`oldest is ${f.oldestWeeks} week${f.oldestWeeks === 1 ? "" : "s"} old`);
  if (f.closedFromRecent > 0) parts.push(`${f.closedFromRecent} closed from this week`);
  return parts.join(" · ") + ".";
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(yyyyMm: string): string {
  const m = parseInt(yyyyMm.slice(5, 7), 10);
  return MONTH_NAMES[m - 1] ?? yyyyMm;
}

/** Period id for the quarter containing an ISO date: "2026-06-10" → "2026-Q2". */
export function currentQuarter(today: string): string {
  const q = Math.floor((parseInt(today.slice(5, 7), 10) - 1) / 3) + 1;
  return `${today.slice(0, 4)}-Q${q}`;
}

/** Human label for a period id: "2026-Q2" → "Q2 2026"; "2026" stays "2026". */
export function periodLabel(period: string): string {
  const [y, q] = period.split("-");
  return q ? `${q} ${y}` : period;
}

/** Fill a trend's sparse counts into exactly `months` trailing buckets
 *  (oldest first), ending at the month containing `today`. */
export function trendSeries(trend: TopicTrend, today: string, months = 6): Array<{ month: string; meetings: number }> {
  const out: Array<{ month: string; meetings: number }> = [];
  const y = parseInt(today.slice(0, 4), 10);
  const m0 = parseInt(today.slice(5, 7), 10) - 1;
  for (let i = months - 1; i >= 0; i--) {
    const total = y * 12 + m0 - i;
    const month = `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
    out.push({ month, meetings: trend.counts.find((c) => c.month === month)?.meetings ?? 0 });
  }
  return out;
}

/** "Pricing came up in 4 meetings in June — up from 1 in May." */
export function trendSentence(term: string, series: Array<{ month: string; meetings: number }>): string {
  const cur = series[series.length - 1];
  const prev = series[series.length - 2];
  if (!cur) return term;
  const name = term.charAt(0).toUpperCase() + term.slice(1);
  const inMonth = `in ${cur.meetings} meeting${cur.meetings === 1 ? "" : "s"} in ${monthLabel(cur.month)}`;
  if (!prev || prev.meetings === cur.meetings) {
    return cur.meetings === 0
      ? `${name} hasn't come up in ${monthLabel(cur.month)}.`
      : `${name} came up ${inMonth}.`;
  }
  const dir = cur.meetings > prev.meetings ? "up" : "down";
  return `${name} came up ${inMonth}, ${dir} from ${prev.meetings} in ${monthLabel(prev.month)}.`;
}
