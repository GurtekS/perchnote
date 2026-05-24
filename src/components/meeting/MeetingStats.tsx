import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, Transcript, SpeakerLabel, Tag } from "../../lib/ipc";
import { extractKeywords } from "../../lib/keywords";
import { Clock, ChevronDown, ChevronRight, Sparkles, Zap } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Segment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
}

interface SpeakerStat {
  name: string;
  talkMs: number;
  runCount: number;
  pct: number;
  wordCount: number;
  wpm: number;
  questionCount: number;
  sentenceCount: number;
  longestRunMs: number;
  avgRunMs: number;
  vocabRichness: number;
}

interface TimelineBucket { speakerName: string | null }

type Tab = "overview" | "speakers" | "timeline" | "topics" | "engagement";

// ─── Colors ──────────────────────────────────────────────────────────────────

const SPEAKER_ACCENTS = [
  "var(--color-accent)",
  "#f87171",
  "#fb923c",
  "#fbbf24",
  "#a3e635",
  "#4ade80",
  "#2dd4bf",
  "#22d3ee",
  "#60a5fa",
  "#818cf8",
  "#c084fc",
  "#f472b6",
];

// ─── Utilities ───────────────────────────────────────────────────────────────

const TIMELINE_BUCKETS = 48;

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function fmtNum(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countQuestions(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

function countSentences(text: string): number {
  return (text.match(/[.!?]+/g) ?? []).length || 1;
}

function parseSegments(raw: string): Segment[] {
  try { return JSON.parse(raw) as Segment[]; }
  catch { return []; }
}

// ─── Computation ─────────────────────────────────────────────────────────────

function computeSpeakerStats(segments: Segment[]): SpeakerStat[] {
  const talkMs     = new Map<string, number>();
  const runCount   = new Map<string, number>();
  const words      = new Map<string, number>();
  const questions  = new Map<string, number>();
  const sentences  = new Map<string, number>();
  const longestRun = new Map<string, number>();
  const wordSets   = new Map<string, Set<string>>();

  let runSpeaker: string | null = null;
  let runMs = 0;

  for (const seg of segments) {
    const name = seg.speaker || "Unknown";
    const dur  = Math.max(0, seg.end_ms - seg.start_ms);

    talkMs.set(name, (talkMs.get(name) ?? 0) + dur);
    words.set(name, (words.get(name) ?? 0) + countWords(seg.text));
    questions.set(name, (questions.get(name) ?? 0) + countQuestions(seg.text));
    sentences.set(name, (sentences.get(name) ?? 0) + countSentences(seg.text));

    if (!wordSets.has(name)) wordSets.set(name, new Set());
    for (const w of seg.text.toLowerCase().split(/\s+/)) {
      if (w.length >= 3) wordSets.get(name)!.add(w.replace(/[^a-z]/g, ""));
    }

    if (name === runSpeaker) {
      runMs += dur;
    } else {
      if (runSpeaker !== null)
        longestRun.set(runSpeaker, Math.max(longestRun.get(runSpeaker) ?? 0, runMs));
      runSpeaker = name;
      runMs = dur;
      runCount.set(name, (runCount.get(name) ?? 0) + 1);
    }
  }
  if (runSpeaker !== null)
    longestRun.set(runSpeaker, Math.max(longestRun.get(runSpeaker) ?? 0, runMs));

  const totalMs = Array.from(talkMs.values()).reduce((a, b) => a + b, 0);

  return Array.from(talkMs.entries())
    .map(([name, ms]) => {
      const wc  = words.get(name) ?? 0;
      const rc  = runCount.get(name) ?? 1;
      const uni = wordSets.get(name)?.size ?? 0;
      return {
        name,
        talkMs: ms,
        runCount: rc,
        pct: totalMs > 0 ? Math.round((ms / totalMs) * 100) : 0,
        wordCount: wc,
        wpm: ms > 0 ? Math.round(wc / (ms / 60000)) : 0,
        questionCount: questions.get(name) ?? 0,
        sentenceCount: sentences.get(name) ?? 0,
        longestRunMs: longestRun.get(name) ?? 0,
        avgRunMs: Math.round(ms / rc),
        vocabRichness: wc > 10 ? Math.round((uni / wc) * 100) : 0,
      };
    })
    .sort((a, b) => b.talkMs - a.talkMs);
}

function computeTimeline(segments: Segment[], durationMs: number): TimelineBucket[] {
  if (durationMs <= 0) return [];
  const bucketMs = durationMs / TIMELINE_BUCKETS;
  const buckets: Map<string, number>[] = Array.from({ length: TIMELINE_BUCKETS }, () => new Map());

  for (const seg of segments) {
    const name  = seg.speaker || "Unknown";
    const first = Math.floor(seg.start_ms / bucketMs);
    const last  = Math.min(TIMELINE_BUCKETS - 1, Math.floor((seg.end_ms - 1) / bucketMs));
    for (let b = first; b <= last; b++) {
      const ov = Math.min(seg.end_ms, (b + 1) * bucketMs) - Math.max(seg.start_ms, b * bucketMs);
      if (ov > 0) buckets[b].set(name, (buckets[b].get(name) ?? 0) + ov);
    }
  }

  return buckets.map(m => {
    if (m.size === 0) return { speakerName: null };
    let best: string | null = null, bestMs = 0;
    for (const [n, ms] of m) if (ms > bestMs) { bestMs = ms; best = n; }
    const total = Array.from(m.values()).reduce((a, b) => a + b, 0);
    return total / bucketMs < 0.15 ? { speakerName: null } : { speakerName: best };
  });
}

function computeExchangeRate(segments: Segment[], durationMs: number): number {
  if (segments.length < 2 || durationMs <= 0) return 0;
  let t = 0;
  for (let i = 1; i < segments.length; i++)
    if (segments[i].speaker && segments[i - 1].speaker &&
        segments[i].speaker !== segments[i - 1].speaker) t++;
  return Math.round((t / (durationMs / 60000)) * 10) / 10;
}

function computeBalanceScore(stats: SpeakerStat[]): number {
  if (stats.length <= 1) return stats.length === 1 ? 100 : 0;
  const ideal = 100 / stats.length;
  const dev   = stats.reduce((s, sp) => s + Math.abs(sp.pct - ideal), 0);
  const max   = 2 * 100 * (1 - 1 / stats.length);
  return Math.round((dev / max) * 100);
}

function computeInterruptions(segments: Segment[], thresholdMs = 800): number {
  let count = 0;
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    if (prev.speaker && curr.speaker && prev.speaker !== curr.speaker) {
      const gap = curr.start_ms - prev.end_ms;
      if (gap < thresholdMs) count++;
    }
  }
  return count;
}

function computeAvgResponseMs(segments: Segment[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    if (prev.speaker && curr.speaker && prev.speaker !== curr.speaker) {
      const gap = curr.start_ms - prev.end_ms;
      if (gap >= 0 && gap < 30_000) gaps.push(gap);
    }
  }
  return gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
}

function computeLongestSilenceMs(segments: Segment[]): number {
  let max = 0;
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].start_ms - segments[i - 1].end_ms;
    if (gap > 0) max = Math.max(max, gap);
  }
  return max;
}

function computeEngagementScore(
  exchangeRate: number,
  balanceScore: number,
  avgResponseMs: number,
  questionDensity: number,
  speakerCount: number,
): number {
  if (speakerCount <= 1) return 0;
  const eScore = Math.min(100, Math.round(Math.max(0, (exchangeRate - 0.5) / 2.5) * 100));
  const bScore = Math.max(0, 100 - balanceScore);
  const rScore = avgResponseMs > 0 ? Math.max(0, Math.round(100 - (avgResponseMs / 5000) * 100)) : 50;
  const qScore = Math.min(100, Math.round((questionDensity / 2) * 100));
  return Math.round(eScore * 0.35 + bScore * 0.30 + rScore * 0.20 + qScore * 0.15);
}

function balanceLabel(score: number, n: number): string {
  if (n <= 1) return "";
  if (score < 20) return "Balanced";
  if (score < 45) return "Mostly balanced";
  if (score < 70) return "Uneven";
  return "Dominated";
}

function engagementLabel(score: number): string {
  if (score >= 75) return "Highly engaged";
  if (score >= 50) return "Good engagement";
  if (score >= 30) return "Low engagement";
  return "Passive / lecture";
}

function engagementColor(score: number): string {
  if (score >= 75) return "#4ade80";
  if (score >= 50) return "#fbbf24";
  if (score >= 30) return "#fb923c";
  return "#f87171";
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface MeetingStatsProps {
  meetingId: string;
  actualStart: string | null | undefined;
  actualEnd: string | null | undefined;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function MeetingStats({ meetingId, actualStart, actualEnd, scheduledStart, scheduledEnd }: MeetingStatsProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const { data: transcript } = useQuery<Transcript | null>({
    queryKey: ["transcript", meetingId],
    queryFn: () => ipc.getTranscriptByMeeting(meetingId),
    enabled: !!actualStart,
  });
  const { data: speakerLabels = [] } = useQuery<SpeakerLabel[]>({
    queryKey: ["speakerLabels", meetingId],
    queryFn: () => ipc.listSpeakerLabelsForMeeting(meetingId),
  });
  const { data: meetingTags = [] } = useQuery<Tag[]>({
    queryKey: ["meetingTags", meetingId],
    queryFn: () => ipc.getMeetingTags(meetingId),
  });

  const speakerNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of speakerLabels) m.set(l.speaker_key, l.display_name);
    return m;
  }, [speakerLabels]);

  const segments = useMemo(
    () => (transcript ? parseSegments(transcript.segments) : []).map(s => ({
      ...s,
      speaker: s.speaker ? (speakerNameMap.get(s.speaker) ?? s.speaker) : s.speaker,
    })),
    [transcript, speakerNameMap]
  );

  const durationMs = useMemo(() => {
    if (actualStart && actualEnd)
      return new Date(actualEnd).getTime() - new Date(actualStart).getTime();
    return segments.length > 0 ? Math.max(...segments.map(s => s.end_ms)) : 0;
  }, [actualStart, actualEnd, segments]);

  const speakerStats  = useMemo(() => computeSpeakerStats(segments), [segments]);
  const timeline      = useMemo(() => computeTimeline(segments, durationMs), [segments, durationMs]);
  const exchangeRate  = useMemo(() => computeExchangeRate(segments, durationMs), [segments, durationMs]);
  const balanceScore  = useMemo(() => computeBalanceScore(speakerStats), [speakerStats]);
  const interruptions = useMemo(() => computeInterruptions(segments), [segments]);
  const avgResponseMs = useMemo(() => computeAvgResponseMs(segments), [segments]);
  const longestSilMs  = useMemo(() => computeLongestSilenceMs(segments), [segments]);

  const nlpKeywords = useMemo(() => extractKeywords(segments), [segments]);
  const aiTags      = meetingTags.length > 0;
  const keywords    = aiTags ? meetingTags.map(t => t.name) : nlpKeywords;

  const totalWords     = useMemo(() => speakerStats.reduce((s, sp) => s + sp.wordCount, 0), [speakerStats]);
  const totalTalkMs    = useMemo(() => speakerStats.reduce((s, sp) => s + sp.talkMs, 0), [speakerStats]);
  const totalRuns      = useMemo(() => speakerStats.reduce((s, sp) => s + sp.runCount, 0), [speakerStats]);
  const totalQuestions = useMemo(() => speakerStats.reduce((s, sp) => s + sp.questionCount, 0), [speakerStats]);
  const overallWpm     = useMemo(() => totalTalkMs > 0 ? Math.round(totalWords / (totalTalkMs / 60000)) : 0, [totalWords, totalTalkMs]);
  const silencePct     = durationMs > 0 ? Math.round((Math.max(0, durationMs - totalTalkMs) / durationMs) * 100) : 0;
  const efficiencyPct  = 100 - silencePct;
  const avgRunMs       = totalRuns > 0 ? Math.round(totalTalkMs / totalRuns) : 0;
  const questionDensity = durationMs > 0 ? totalQuestions / (durationMs / 60000) : 0;

  const engagementScore = useMemo(
    () => computeEngagementScore(exchangeRate, balanceScore, avgResponseMs, questionDensity, speakerStats.length),
    [exchangeRate, balanceScore, avgResponseMs, questionDensity, speakerStats.length]
  );

  const longestMonologue = useMemo(() => {
    if (!speakerStats.length) return null;
    const best = speakerStats.reduce((p, c) => c.longestRunMs > p.longestRunMs ? c : p);
    return best.longestRunMs > 0 ? { name: best.name, ms: best.longestRunMs } : null;
  }, [speakerStats]);

  const lateStartMins = useMemo(() => {
    if (!scheduledStart || !actualStart) return 0;
    const d = (new Date(actualStart).getTime() - new Date(scheduledStart).getTime()) / 60000;
    return d > 2 ? Math.round(d) : 0;
  }, [scheduledStart, actualStart]);

  const overtimeMins = useMemo(() => {
    if (!scheduledEnd || !actualEnd) return 0;
    const d = (new Date(actualEnd).getTime() - new Date(scheduledEnd).getTime()) / 60000;
    return d > 2 ? Math.round(d) : 0;
  }, [scheduledEnd, actualEnd]);

  const speakerColor = useMemo(() => {
    const m = new Map<string, string>();
    speakerStats.forEach((s, i) => m.set(s.name, SPEAKER_ACCENTS[i % SPEAKER_ACCENTS.length]));
    return m;
  }, [speakerStats]);

  const hasSpeakers         = speakerStats.length > 0;
  const hasMultipleSpeakers = speakerStats.length > 1;
  const hasTimeline         = timeline.some(b => b.speakerName !== null);

  if (!actualStart || segments.length === 0) return null;

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview",   label: "Overview"   },
    { id: "speakers",   label: "Speakers"   },
    { id: "timeline",   label: "Timeline"   },
    { id: "topics",     label: "Topics"     },
    { id: "engagement", label: "Engagement" },
  ];

  return (
    <div className="mb-5 rounded-xl overflow-hidden"
      style={{ background: "var(--glass-panel-bg)", border: "1px solid var(--glass-panel-border)" }}>

      {/* Collapsible header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-hover/40 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Clock size={12} className="text-text-muted shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted shrink-0">
            Meeting Stats
          </span>
          {!expanded && (
            <span className="text-[11px] text-text-muted truncate">
              · {fmtMs(durationMs)}
              {totalWords > 0 && ` · ${fmtNum(totalWords)} words`}
              {hasSpeakers && ` · ${speakerStats.length} speaker${speakerStats.length !== 1 ? "s" : ""}`}
              {hasMultipleSpeakers && engagementScore > 0 && ` · eng ${engagementScore}`}
            </span>
          )}
        </div>
        {expanded
          ? <ChevronDown size={12} className="text-text-muted shrink-0" />
          : <ChevronRight size={12} className="text-text-muted shrink-0" />}
      </button>

      {expanded && (
        <div>
          {/* Tab bar */}
          <div className="flex items-center gap-px px-3 border-b border-border/40">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-2 text-[11px] font-medium transition-colors border-b-2 -mb-px ${
                  activeTab === tab.id
                    ? "border-accent text-accent"
                    : "border-transparent text-text-muted hover:text-text-secondary"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="px-4 py-4">

            {/* OVERVIEW */}
            {activeTab === "overview" && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-x-4 gap-y-3">
                  <StatCell label="Duration"    value={fmtMs(durationMs)} />
                  {totalWords > 0     && <StatCell label="Words"         value={fmtNum(totalWords)} />}
                  {overallWpm > 0     && <StatCell label="Pace"          value={`${overallWpm} wpm`} />}
                  {hasSpeakers        && <StatCell label="Speakers"      value={String(speakerStats.length)} />}
                  {efficiencyPct > 0  && <StatCell label="Active"        value={`${efficiencyPct}%`} title="Percentage of meeting with speech" />}
                  {totalQuestions > 0 && <StatCell label="Questions"     value={String(totalQuestions)} />}
                  {exchangeRate > 0 && hasMultipleSpeakers &&
                    <StatCell label="Exchanges"   value={`${exchangeRate}/min`} title="Speaker changes per minute" />}
                  {avgRunMs > 0       && <StatCell label="Avg turn"      value={fmtMs(avgRunMs)} title="Average uninterrupted speaking run" />}
                  {silencePct > 8     && <StatCell label="Silence"       value={`${silencePct}%`} />}
                  {interruptions > 0 && hasMultipleSpeakers &&
                    <StatCell label="Interruptions" value={String(interruptions)} title="Rapid speaker changes under 0.8s" />}
                  {hasMultipleSpeakers && engagementScore > 0 &&
                    <StatCell label="Engagement"  value={`${engagementScore}/100`} title={engagementLabel(engagementScore)} />}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 pt-3 border-t border-border/40">
                  {hasMultipleSpeakers && (
                    <InsightPill label={balanceLabel(balanceScore, speakerStats.length)} faint={balanceScore < 30} />
                  )}
                  {hasMultipleSpeakers && engagementScore > 0 && (
                    <InsightPill label={engagementLabel(engagementScore)} faint={engagementScore >= 50} warn={engagementScore < 30} />
                  )}
                  {longestMonologue && (
                    <InsightPill label={`Longest run: ${longestMonologue.name} · ${fmtMs(longestMonologue.ms)}`} faint />
                  )}
                  {lateStartMins > 0 && <InsightPill label={`Started ${lateStartMins}m late`} warn />}
                  {overtimeMins  > 0 && <InsightPill label={`Ran ${overtimeMins}m over`} warn />}
                </div>
              </div>
            )}

            {/* SPEAKERS */}
            {activeTab === "speakers" && (
              <div className="space-y-3">
                {!hasSpeakers && (
                  <p className="text-xs text-text-muted">No speaker data available.</p>
                )}
                {speakerStats.map((stat, i) => {
                  const color = SPEAKER_ACCENTS[i % SPEAKER_ACCENTS.length];
                  const avgSentLen = stat.sentenceCount > 0
                    ? Math.round(stat.wordCount / stat.sentenceCount)
                    : 0;
                  return (
                    <div key={stat.name} className="space-y-1.5 pb-3 border-b border-border/30 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                          <span className="text-sm font-semibold text-text-primary truncate max-w-[140px]">{stat.name}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-text-muted">{fmtMs(stat.talkMs)}</span>
                          <span className="text-sm font-bold w-9 text-right" style={{ color }}>{stat.pct}%</span>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--glass-header-border)" }}>
                        <div className="h-full rounded-full" style={{ width: `${stat.pct}%`, background: color, opacity: 0.8 }} />
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
                        {stat.runCount > 0     && <MicroStat label="turns"    value={String(stat.runCount)} />}
                        {stat.wpm > 0          && <MicroStat label="wpm"      value={String(stat.wpm)} />}
                        {stat.avgRunMs > 0     && <MicroStat label="avg turn" value={fmtMs(stat.avgRunMs)} />}
                        {stat.longestRunMs > 0 && <MicroStat label="longest"  value={fmtMs(stat.longestRunMs)} />}
                        {stat.wordCount > 0    && <MicroStat label="words"    value={fmtNum(stat.wordCount)} />}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {stat.questionCount > 0  && <MicroStat label="questions"      value={String(stat.questionCount)} color={color} />}
                        {avgSentLen > 0           && <MicroStat label="words/sentence" value={String(avgSentLen)} />}
                        {stat.vocabRichness > 0   && <MicroStat label="vocab richness" value={`${stat.vocabRichness}%`} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* TIMELINE */}
            {activeTab === "timeline" && (
              <div className="space-y-3">
                {!hasTimeline || durationMs < 60_000 ? (
                  <p className="text-xs text-text-muted">Not enough data for a timeline.</p>
                ) : (
                  <>
                    <div className="flex gap-px rounded-md overflow-hidden h-5">
                      {timeline.map((b, i) => {
                        const color = b.speakerName ? speakerColor.get(b.speakerName) : undefined;
                        return (
                          <div key={i} className="flex-1"
                            title={b.speakerName ?? "Silence"}
                            style={{ background: color ?? "var(--glass-header-border)", opacity: color ? 0.8 : 0.3 }} />
                        );
                      })}
                    </div>
                    <div className="flex justify-between text-[10px] text-text-muted px-0.5">
                      <span>0:00</span>
                      <span>{fmtMs(durationMs * 0.25)}</span>
                      <span>{fmtMs(durationMs * 0.5)}</span>
                      <span>{fmtMs(durationMs * 0.75)}</span>
                      <span>{fmtMs(durationMs)}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1 border-t border-border/30">
                      {speakerStats.map(s => (
                        <div key={s.name} className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded shrink-0"
                            style={{ background: speakerColor.get(s.name), opacity: 0.8 }} />
                          <span className="text-[11px] text-text-secondary truncate max-w-[100px]">{s.name}</span>
                          <span className="text-[10px] text-text-muted">{s.pct}%</span>
                        </div>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded shrink-0"
                          style={{ background: "var(--glass-header-border)", opacity: 0.6 }} />
                        <span className="text-[11px] text-text-muted">Silence {silencePct}%</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* TOPICS */}
            {activeTab === "topics" && (
              <div className="space-y-3">
                {keywords.length === 0 ? (
                  <p className="text-xs text-text-muted">Generate notes with AI to surface key topics.</p>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5">
                      {aiTags ? (
                        <>
                          <Sparkles size={11} className="text-accent shrink-0" />
                          <span className="text-[10px] text-accent font-medium">From AI notes</span>
                        </>
                      ) : (
                        <span className="text-[10px] text-text-muted">From transcript · generate notes for AI topics</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {keywords.map((w, i) => {
                        const isTop = i < 3;
                        return (
                          <span key={w}
                            className={`px-2.5 py-1 rounded-full border ${
                              isTop
                                ? "text-xs text-text-primary bg-bg-tertiary border-border/60 font-medium"
                                : "text-[11px] text-text-secondary bg-bg-tertiary border-border"
                            }`}>
                            {w}
                          </span>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ENGAGEMENT */}
            {activeTab === "engagement" && (
              <div className="space-y-4">
                {!hasMultipleSpeakers ? (
                  <p className="text-xs text-text-muted">Engagement metrics require multiple speakers.</p>
                ) : (
                  <>
                    {/* Score */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5">
                          <Zap size={11} className="text-text-muted" />
                          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">
                            Engagement Score
                          </span>
                        </div>
                        <span className="text-xl font-bold tabular-nums"
                          style={{ color: engagementColor(engagementScore) }}>
                          {engagementScore}
                          <span className="text-sm font-normal text-text-muted">/100</span>
                        </span>
                      </div>
                      <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--glass-header-border)" }}>
                        <div className="h-full rounded-full"
                          style={{ width: `${engagementScore}%`, background: engagementColor(engagementScore) }} />
                      </div>
                      <p className="text-[10px] text-text-muted mt-1.5">{engagementLabel(engagementScore)}</p>
                    </div>

                    {/* Metrics */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-3 border-t border-border/40">
                      {exchangeRate > 0 && (
                        <StatCell label="Exchange rate" value={`${exchangeRate}/min`}
                          title="Speaker changes per minute" />
                      )}
                      {avgResponseMs > 0 && (
                        <StatCell label="Avg response" value={fmtMs(avgResponseMs)}
                          title="Average gap between consecutive different speakers" />
                      )}
                      {interruptions > 0 && (
                        <StatCell label="Interruptions" value={String(interruptions)}
                          title="Speaker changes with gap < 0.8s" />
                      )}
                      {longestSilMs > 5_000 && (
                        <StatCell label="Longest silence" value={fmtMs(longestSilMs)} />
                      )}
                      {totalQuestions > 0 && (
                        <StatCell label="Questions" value={String(totalQuestions)} />
                      )}
                      {totalRuns > 0 && (
                        <StatCell label="Total turns" value={String(totalRuns)} />
                      )}
                    </div>

                    {/* Factor bars */}
                    <div className="space-y-2 pt-3 border-t border-border/40">
                      <p className="text-[10px] text-text-muted uppercase tracking-wider font-medium mb-2">Score Breakdown</p>
                      {([
                        {
                          label: "Back-and-forth",
                          pct: Math.min(100, Math.round(Math.max(0, (exchangeRate - 0.5) / 2.5) * 100)),
                        },
                        {
                          label: "Balance",
                          pct: Math.max(0, 100 - balanceScore),
                        },
                        {
                          label: "Response speed",
                          pct: avgResponseMs > 0 ? Math.max(0, Math.round(100 - (avgResponseMs / 5000) * 100)) : 50,
                        },
                        {
                          label: "Question density",
                          pct: Math.min(100, Math.round((questionDensity / 2) * 100)),
                        },
                      ] as { label: string; pct: number }[]).map(f => (
                        <div key={f.label}>
                          <div className="flex justify-between text-[10px] mb-0.5">
                            <span className="text-text-secondary">{f.label}</span>
                            <span className="text-text-muted tabular-nums">{f.pct}</span>
                          </div>
                          <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--glass-header-border)" }}>
                            <div className="h-full rounded-full"
                              style={{ width: `${f.pct}%`, background: engagementColor(f.pct) }} />
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Vocab richness */}
                    {speakerStats.some(s => s.vocabRichness > 0) && (
                      <div className="pt-3 border-t border-border/40">
                        <p className="text-[10px] text-text-muted uppercase tracking-wider font-medium mb-2">
                          Vocabulary Richness
                        </p>
                        <div className="space-y-2">
                          {speakerStats.filter(s => s.vocabRichness > 0).map((stat) => {
                            const color = speakerColor.get(stat.name) ?? SPEAKER_ACCENTS[0];
                            return (
                              <div key={stat.name} className="flex items-center gap-2">
                                <span className="text-[11px] text-text-secondary w-24 truncate shrink-0">{stat.name}</span>
                                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--glass-header-border)" }}>
                                  <div className="h-full rounded-full"
                                    style={{ width: `${stat.vocabRichness}%`, background: color, opacity: 0.75 }} />
                                </div>
                                <span className="text-[10px] text-text-muted w-8 text-right tabular-nums shrink-0">
                                  {stat.vocabRichness}%
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-text-muted mt-1.5">
                          Unique words ÷ total words — higher = more varied vocabulary
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <p className="text-[10px] text-text-muted leading-none mb-1">{label}</p>
      <p className="text-sm font-semibold text-text-primary leading-tight">{value}</p>
    </div>
  );
}

function MicroStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="text-[10px] text-text-muted">
      <span style={{ color }} className={color ? "font-medium" : ""}>{value}</span>
      {" "}{label}
    </span>
  );
}

function InsightPill({ label, faint, warn }: { label: string; faint?: boolean; warn?: boolean }) {
  return (
    <span className={`text-[11px] ${warn ? "text-amber-400" : faint ? "text-text-muted" : "text-text-secondary"}`}>
      {label}
    </span>
  );
}
