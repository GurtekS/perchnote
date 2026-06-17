import { useCallback } from "react";
import { BookOpen, Copy, X } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useUIStore } from "../../stores/uiStore";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";

/**
 * The output of a per-series auto-run recipe (plan v10 #8): a dismissible
 * card on the meeting it ran against — deliberately NOT notes content and
 * not persisted anywhere. One session-transient slot in uiStore; dismiss
 * (or restart) and it's gone, same "copy what you need" stance as a
 * manual recipe run.
 */
export function RecipeAutoRunCard({ meetingId }: { meetingId: string }) {
  const card = useUIStore((s) => s.recipeCard);
  const dismiss = useUIStore((s) => s.dismissRecipeCard);

  const copy = useCallback(async () => {
    if (!card) return;
    try {
      await ipc.writeClipboard(card.text);
      toast.success("Copied to clipboard");
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  }, [card]);

  if (!card || card.meetingId !== meetingId) return null;

  return (
    <div className="card mb-3 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <BookOpen size={11} className="shrink-0 text-accent" />
        <span className="text-footnote font-semibold uppercase tracking-wider text-text-muted">
          {card.recipeName} — ran automatically
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={copy}
          className="rounded p-1 text-text-muted transition-colors hover:text-text-primary"
          title="Copy output"
          aria-label="Copy recipe output"
        >
          <Copy size={11} />
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded p-1 text-text-muted transition-colors hover:text-text-primary"
          title="Dismiss"
          aria-label="Dismiss recipe output"
        >
          <X size={11} />
        </button>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-body-sm leading-relaxed text-text-primary">
        {card.text}
      </p>
      <p className="mt-1.5 text-footnote text-text-muted">
        Not saved anywhere — copy what you need. Manage auto-run in Recipes.
      </p>
    </div>
  );
}
