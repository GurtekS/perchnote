import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Award, BookOpen, Download, Loader2, RefreshCw, ArrowRight } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { currentQuarter, periodLabel } from "./insightsMath";

/**
 * "Year so far" (plan v9 item 14): the monthly narrative's longer-horizon
 * sibling. Quarter/year narratives are one provider call over the same
 * counts/hours/titles-only facts JSON (cached per period, inspectable
 * verbatim). The brag doc is deterministic markdown built locally from
 * completed tasks — no AI involved, so it works without a provider.
 */
export function PeriodCard({ today }: { today: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<"quarter" | "year">("quarter");
  const period = scope === "quarter" ? currentQuarter(today) : today.slice(0, 4);
  const label = periodLabel(period);

  const { data: narrative } = useQuery({
    queryKey: ["period-narrative", period],
    queryFn: () => ipc.getPeriodNarrative(period),
  });
  const { data: aiReady = false } = useQuery({
    queryKey: ["ai-configured"],
    queryFn: ipc.checkAiConfigured,
  });

  const generate = useMutation({
    mutationFn: () => ipc.generatePeriodNarrative(period),
    onSuccess: (insight) => {
      queryClient.setQueryData(["period-narrative", period], insight);
    },
    onError: (e) => toast.error(toUserMessage(e), "Narrative failed"),
  });

  const exportDoc = useMutation({
    mutationFn: () => ipc.exportBragDoc(period),
    onSuccess: (path) => toast.success(`Saved to ${path}`, "Brag doc exported"),
    onError: (e) => toast.error(toUserMessage(e), "Export failed"),
  });

  const prettyFacts = (() => {
    if (!narrative) return "";
    try {
      return JSON.stringify(JSON.parse(narrative.facts), null, 2);
    } catch {
      return narrative.facts;
    }
  })();

  return (
    <section className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="section-label m-0 flex items-center gap-1.5">
          <Award size={11} />
          Year so far
        </p>
        <div className="view-toggle-pill" role="group" aria-label="Narrative period">
          <button
            type="button"
            onClick={() => setScope("quarter")}
            className={scope === "quarter" ? "active" : ""}
            aria-pressed={scope === "quarter"}
          >
            This quarter
          </button>
          <button
            type="button"
            onClick={() => setScope("year")}
            className={scope === "year" ? "active" : ""}
            aria-pressed={scope === "year"}
          >
            This year
          </button>
        </div>
      </div>

      {narrative ? (
        <>
          {narrative.content.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="m-0 mt-2 first:mt-0 text-sm leading-relaxed text-text-primary">
              {para}
            </p>
          ))}
          <div className="mt-3 flex items-center gap-4">
            <button
              type="button"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              {generate.isPending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <RefreshCw size={11} />
              )}
              Regenerate
            </button>
            <details className="text-xs text-text-muted">
              <summary className="cursor-pointer hover:text-text-secondary">
                What the AI saw
              </summary>
              <p className="mt-2 mb-1 text-footnote">
                The narrative was generated from only these numbers and titles.
                No transcripts, no notes:
              </p>
              <pre className="m-0 max-h-48 overflow-auto rounded-lg bg-bg-primary/60 p-2 text-footnote leading-snug">
                {prettyFacts}
              </pre>
            </details>
          </div>
        </>
      ) : aiReady ? (
        <>
          <p className="m-0 text-sm text-text-secondary">
            A few honest paragraphs on the arc of your {label}: how it ramped,
            what recurred, what moved. Built from counts and titles only.
            Your transcripts and notes are never sent.
          </p>
          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-60"
          >
            {generate.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <BookOpen size={12} />
            )}
            Write it
          </button>
        </>
      ) : (
        <>
          <p className="m-0 text-sm text-text-secondary">
            Connect an AI provider to get a short written reflection on your
            {" "}{label}, generated from counts and titles only.
          </p>
          <button
            type="button"
            onClick={() => navigate({ to: "/settings", search: { section: "ai" } })}
            className="mt-3 flex items-center gap-1 text-xs text-accent hover:underline"
          >
            Set up a provider <ArrowRight size={11} />
          </button>
        </>
      )}

      {/* The brag doc is deterministic — no provider needed, never AI-gated. */}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => exportDoc.mutate()}
          disabled={exportDoc.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-60"
        >
          {exportDoc.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} />
          )}
          Export brag doc
        </button>
        <span className="text-footnote text-text-muted">
          Markdown of your completed items to the Desktop. No AI, just facts.
        </span>
      </div>
    </section>
  );
}
