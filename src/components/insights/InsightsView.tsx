import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CalendarDays, ListChecks, Hash, ArrowRight } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { Sparkline } from "./Sparkline";
import { NarrativeCard } from "./NarrativeCard";
import { PeriodCard } from "./PeriodCard";
import {
  hourHistogram,
  loadHeadline,
  monthLabel,
  openLoopFacts,
  openLoopHeadline,
  peakWindowSentence,
  trendSentence,
  trendSeries,
  weeklyLoad,
} from "./insightsMath";

/**
 * /insights (plan v6 items 10-13): sentence-first, at most a handful of
 * modules, no filters or date pickers. Every stat answers "is that good?"
 * against the user's own history, and every module ends in one action.
 * Everything is computed locally.
 */
export function InsightsView() {
  const navigate = useNavigate();
  const now = new Date();
  // Local-midnight today, ISO — matches the Tasks view's date math.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
    .toISOString()
    .slice(0, 10);

  const { data: meetings = [] } = useQuery({ queryKey: ["meetings"], queryFn: ipc.listMeetings });
  const { data: items = [] } = useQuery({ queryKey: ["action-items"], queryFn: ipc.listActionItems });
  const { data: trends = [] } = useQuery({ queryKey: ["topic-trends"], queryFn: ipc.getTopicTrends });

  const weeks = useMemo(() => weeklyLoad(meetings, today), [meetings, today]);
  const histogram = useMemo(() => hourHistogram(meetings, today), [meetings, today]);
  const peak = peakWindowSentence(histogram);
  const loops = useMemo(() => openLoopFacts(items, today), [items, today]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="m-0 text-lg font-semibold text-text-primary">Insights</h1>
      <p className="mt-1 mb-6 text-xs text-text-muted">
        Computed on this Mac from your own meetings — nothing leaves it.
      </p>

      <div className="space-y-4">
        {/* Meeting load */}
        <section className="card p-4">
          <p className="section-label mb-2 flex items-center gap-1.5">
            <CalendarDays size={11} />
            Meeting load
          </p>
          <p className="m-0 text-sm text-text-primary">{loadHeadline(weeks)}</p>
          <div className="mt-3 flex items-end gap-3">
            <Sparkline
              values={weeks.map((w) => w.hours)}
              label={`Meeting hours per week, last 12 weeks: ${weeks.map((w) => w.hours).join(", ")}`}
            />
            <span className="text-footnote text-text-muted">12 weeks</span>
          </div>
          {peak && <p className="mt-2 mb-0 text-xs text-text-secondary">{peak}</p>}
          <button
            type="button"
            onClick={() => navigate({ to: "/calendar" })}
            className="mt-3 flex items-center gap-1 text-xs text-accent hover:underline"
          >
            Open calendar <ArrowRight size={11} />
          </button>
        </section>

        {/* Open loops */}
        <section className="card p-4">
          <p className="section-label mb-2 flex items-center gap-1.5">
            <ListChecks size={11} />
            Open loops
          </p>
          <p className="m-0 text-sm text-text-primary">{openLoopHeadline(loops)}</p>
          {loops.open > 0 && (
            <button
              type="button"
              onClick={() => navigate({ to: "/tasks" })}
              className="mt-3 flex items-center gap-1 text-xs text-accent hover:underline"
            >
              {loops.staleCount > 0
                ? `Review ${loops.staleCount} stale item${loops.staleCount === 1 ? "" : "s"}`
                : "Open tasks"}{" "}
              <ArrowRight size={11} />
            </button>
          )}
        </section>

        {/* Monthly narrative */}
        <NarrativeCard month={today.slice(0, 7)} />

        {/* Quarter/year narrative + brag-doc export */}
        <PeriodCard today={today} />

        {/* Topic trends */}
        <section className="card p-4">
          <p className="section-label mb-2 flex items-center gap-1.5">
            <Hash size={11} />
            Topic trends
          </p>
          {trends.length === 0 ? (
            <>
              <p className="m-0 text-sm text-text-secondary">
                Track terms that matter — a project, a customer, "pricing" — and
                see how often they come up, month over month.
              </p>
              <button
                type="button"
                onClick={() => navigate({ to: "/settings", search: { section: "audio" } })}
                className="mt-3 flex items-center gap-1 text-xs text-accent hover:underline"
              >
                Add topic trackers in Settings <ArrowRight size={11} />
              </button>
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {trends.map((t) => {
                const series = trendSeries(t, today);
                return (
                  <div key={t.term}>
                    <p className="m-0 text-xs text-text-primary">{trendSentence(t.term, series)}</p>
                    <div className="mt-2 flex items-end gap-2">
                      <Sparkline
                        values={series.map((s) => s.meetings)}
                        label={`${t.term}: meetings per month, ${monthLabel(series[0].month)} through ${monthLabel(series[series.length - 1].month)}`}
                        height={22}
                      />
                      <span className="text-footnote text-text-muted">6 mo</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
