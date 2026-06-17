import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, History, Loader2 } from "lucide-react";
import { ipc, Note, PreviousGenerated } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { serializeTiptapToMarkdown } from "../../lib/tiptap/serializeTiptap";

/** Human label for a receipt's provider/model pair.
 *  "anthropic" + "claude-sonnet-4-6" → "Claude Sonnet"; ollama shows the
 *  local model name; apple is always on-device. Unknown inputs degrade to
 *  whatever string we have rather than guessing. */
export function receiptModelLabel(
  provider: string | null | undefined,
  model: string | null | undefined,
): string {
  if (provider === "anthropic") {
    const m = (model ?? "").toLowerCase();
    if (m.includes("opus")) return "Claude Opus";
    if (m.includes("sonnet")) return "Claude Sonnet";
    if (m.includes("haiku")) return "Claude Haiku";
    if (m.includes("fable")) return "Claude Fable";
    return "Claude";
  }
  if (provider === "ollama") return model ? `Ollama (${model})` : "Ollama";
  if (provider === "apple") return "Apple Intelligence";
  return model || provider || "AI";
}

/** "Jun 10, 2:32 PM" — falls back to the raw string when unparseable. */
export function formatReceiptTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Parse the one-slot previous-version envelope; null when absent/corrupt. */
function parsePrevious(note: Note | null | undefined): PreviousGenerated | null {
  if (!note?.generated_previous) return null;
  try {
    const env = JSON.parse(note.generated_previous) as PreviousGenerated;
    return typeof env?.content === "string" && env.content ? env : null;
  } catch {
    return null;
  }
}

interface Props {
  meetingId: string;
  note: Note | null | undefined;
}

/**
 * The quiet enhance receipt under the AI notes (plan v10 #2):
 * "Claude Sonnet · Jun 10, 2:32 PM · from the transcript as of generation".
 *
 * - Renders NOTHING when the note has no receipt (pre-migration-18 notes,
 *   never-enhanced notes) — provenance must never shame the no-AI path.
 * - When the live transcript hash differs from the receipt's, an amber
 *   "Transcript changed after these notes" badge appears with a Re-enhance
 *   shortcut (same trigger as the command palette).
 * - After a re-enhance, "View previous" shows the replaced version
 *   (markdown, read-only) and Restore swaps it back — receipts included.
 */
export function NotesReceipt({ meetingId, note }: Props) {
  const queryClient = useQueryClient();
  const [showPrevious, setShowPrevious] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const hasReceipt = Boolean(note?.generated_content && note?.generated_at);
  const storedSha = note?.generated_transcript_sha ?? null;

  const { data: liveSha } = useQuery({
    queryKey: ["transcript-sha", meetingId, note?.generated_at ?? ""],
    queryFn: () => ipc.getTranscriptSha(meetingId),
    enabled: hasReceipt && !!storedSha,
    staleTime: 15_000,
  });

  if (!note || !hasReceipt) return null;

  const stale = !!storedSha && !!liveSha && storedSha !== liveSha;
  const previous = parsePrevious(note);
  let previousMarkdown = "";
  if (previous?.content) {
    try {
      previousMarkdown = serializeTiptapToMarkdown(JSON.parse(previous.content));
    } catch {
      previousMarkdown = "";
    }
  }

  const handleRestore = async () => {
    setRestoring(true);
    try {
      await ipc.restorePreviousNotes(note.id);
      queryClient.invalidateQueries({ queryKey: ["note", meetingId] });
      queryClient.invalidateQueries({ queryKey: ["action-items"] });
      queryClient.invalidateQueries({ queryKey: ["note-previews"] });
      setShowPrevious(false);
      toast.success("Previous notes restored");
    } catch (e) {
      toast.error(toUserMessage(e, "Restore failed"), "Restore failed");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="mt-3 border-t border-border/60 pt-2" data-testid="notes-receipt">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-footnote m-0 text-text-muted">
          {receiptModelLabel(note.generated_provider, note.generated_model)}
          {" · "}
          {formatReceiptTime(note.generated_at!)}
          {" · from the transcript as of generation"}
        </p>
        {previous && (
          <button
            type="button"
            onClick={() => setShowPrevious((v) => !v)}
            className="text-footnote inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          >
            <History size={10} />
            {showPrevious ? "Hide previous" : "View previous"}
          </button>
        )}
      </div>

      {stale && (
        <div
          role="status"
          className="mt-1.5 inline-flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1"
        >
          <AlertTriangle size={11} className="shrink-0 text-amber-500" />
          <span className="text-footnote text-amber-500">
            Transcript changed after these notes
          </span>
          <button
            type="button"
            onClick={() => document.dispatchEvent(new CustomEvent("palette-enhance-notes"))}
            className="text-footnote rounded px-1 py-0.5 font-medium text-amber-500 underline-offset-2 hover:underline"
          >
            Re-enhance
          </button>
        </div>
      )}

      {showPrevious && previous && (
        <div className="card mt-2 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="section-label m-0">
              Previous version
              {previous.generated_at || previous.provider ? (
                <span className="ml-1.5 font-normal normal-case tracking-normal text-text-muted">
                  {[
                    previous.provider
                      ? receiptModelLabel(previous.provider, previous.model)
                      : null,
                    previous.generated_at ? formatReceiptTime(previous.generated_at) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </p>
            <button
              type="button"
              onClick={handleRestore}
              disabled={restoring}
              className="text-caption inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
            >
              {restoring && <Loader2 size={10} className="animate-spin" />}
              Restore
            </button>
          </div>
          <pre className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-text-secondary">
            {previousMarkdown || "(empty)"}
          </pre>
        </div>
      )}
    </div>
  );
}
