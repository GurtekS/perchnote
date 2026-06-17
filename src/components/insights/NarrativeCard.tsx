import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BookOpen, Loader2, RefreshCw, ArrowRight } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { monthLabel } from "./insightsMath";

/**
 * "Your June" (plan v6 item 14): one provider call over a facts JSON of
 * counts, hours, and titles — never transcripts or note bodies — cached
 * per month. The exact facts ride along so the user can see precisely
 * what the AI was given.
 */
export function NarrativeCard({ month }: { month: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: narrative } = useQuery({
    queryKey: ["monthly-narrative", month],
    queryFn: () => ipc.getMonthlyNarrative(month),
  });
  const { data: aiReady = false } = useQuery({
    queryKey: ["ai-configured"],
    queryFn: ipc.checkAiConfigured,
  });

  const generate = useMutation({
    mutationFn: () => ipc.generateMonthlyNarrative(month),
    onSuccess: (insight) => {
      queryClient.setQueryData(["monthly-narrative", month], insight);
    },
    onError: (e) => toast.error(toUserMessage(e), "Narrative failed"),
  });

  const label = monthLabel(month);
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
      <p className="section-label mb-2 flex items-center gap-1.5">
        <BookOpen size={11} />
        Your {label}
      </p>

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
            A few honest paragraphs about your {label}: how the month ran,
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
            month, generated from counts and titles only.
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
    </section>
  );
}
