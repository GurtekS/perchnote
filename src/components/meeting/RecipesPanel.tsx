import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Copy, Loader2, Pencil, Play, Plus, Repeat, X } from "lucide-react";
import { ipc } from "../../lib/ipc";
import {
  addRecipe,
  deleteRecipe,
  getSeriesRecipe,
  loadRecipes,
  seriesRecipeKey,
  setSeriesRecipe,
  updateRecipe,
  type Recipe,
} from "../../lib/recipes";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { extractFilterChips, FILTER_HINT } from "../../lib/searchFilterHints";
import { FilterChips } from "../shared/FilterChips";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";

interface RecipesPanelProps {
  meetingId: string;
  /** Current meeting title — keys the per-series auto-run binding. */
  meetingTitle: string;
  isOpen: boolean;
  onClose: () => void;
}

/** Inline editor draft; `id: null` means a brand-new recipe. */
interface Draft {
  id: string | null;
  name: string;
  prompt: string;
  scope: string;
}

/**
 * Recipes panel (plan v9 #6): saved prompts, one click from this meeting.
 * Each run is exactly an Ask AI question — chat_with_meeting with the
 * recipe's prompt — so the injection posture is unchanged. Output is a
 * transient surface with Copy; it NEVER writes into the notes and isn't
 * persisted to chat history (same "not saved anywhere" stance as the
 * catch-me-up card).
 */
export function RecipesPanel({ meetingId, meetingTitle, isOpen, onClose }: RecipesPanelProps) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(isOpen, dialogRef, onClose);

  const { data: recipes = [], isLoading: recipesLoading } = useQuery({
    queryKey: ["recipes"],
    queryFn: loadRecipes,
    enabled: isOpen,
  });

  const [running, setRunning] = useState<Recipe | null>(null);
  const [output, setOutput] = useState<{ recipe: Recipe; text: string } | null>(null);
  const [runError, setRunError] = useState<{ recipe: Recipe; message: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Stale-response guard (same pattern as AskAIOverlay): close/reopen or a
  // newer run orphans whatever is still in flight.
  const requestSeq = useRef(0);

  useEffect(() => {
    if (isOpen) {
      requestSeq.current++;
      setRunning(null);
      setOutput(null);
      setRunError(null);
      setDraft(null);
    }
  }, [isOpen]);

  const runRecipe = useCallback(
    async (recipe: Recipe) => {
      if (running) return;
      const token = ++requestSeq.current;
      setRunning(recipe);
      setOutput(null);
      setRunError(null);
      try {
        const scope = recipe.scope?.trim();
        let answer: string;
        if (scope) {
          // Scoped recipe (plan v10 #8): the same corpus run as Ask AI's
          // All-meetings mode — recent completed meetings as the candidate
          // set, the recipe's typed filters prepended to the question so
          // retrieval is scoped server-side (folder:/speaker:/before:/after:).
          const all = await ipc.listMeetings();
          const recentIds = all
            .filter((m) => m.status === "complete")
            .slice(0, 15)
            .map((m) => m.id);
          const contextIds =
            meetingId && !recentIds.includes(meetingId)
              ? [meetingId, ...recentIds].slice(0, 15)
              : recentIds;
          const result = await ipc.chatWithMeetings(contextIds, `${scope} ${recipe.prompt}`);
          answer = result.answer;
        } else {
          answer = await ipc.chatWithMeeting(meetingId, recipe.prompt);
        }
        if (token !== requestSeq.current) return;
        setOutput({ recipe, text: answer });
      } catch (e) {
        if (token !== requestSeq.current) return;
        setRunError({ recipe, message: toUserMessage(e) });
      } finally {
        if (token === requestSeq.current) setRunning(null);
      }
    },
    [meetingId, running],
  );

  const copyOutput = useCallback(async () => {
    if (!output) return;
    try {
      await ipc.writeClipboard(output.text);
      toast.success("Copied to clipboard");
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  }, [output]);

  // Per-series auto-run binding (plan v10 #8): offered on a successful run
  // when the title looks like a series. One recipe per series; the toggle
  // binds this recipe or clears its own binding.
  const seriesKey = seriesRecipeKey(meetingTitle);
  const { data: boundRecipe } = useQuery({
    queryKey: ["series-recipe", seriesKey],
    queryFn: () => getSeriesRecipe(meetingTitle),
    enabled: isOpen && seriesKey !== null,
  });
  const toggleSeriesBinding = useCallback(
    async (recipe: Recipe) => {
      try {
        const bindingIsMine = boundRecipe?.id === recipe.id;
        await setSeriesRecipe(meetingTitle, bindingIsMine ? null : recipe.id);
        queryClient.invalidateQueries({ queryKey: ["series-recipe", seriesKey] });
        toast.success(
          bindingIsMine
            ? `"${recipe.name}" will no longer auto-run for this series`
            : `"${recipe.name}" will run automatically when meetings like this finish. Output appears as a dismissible card, never in your notes.`,
        );
      } catch (e) {
        toast.error(toUserMessage(e));
      }
    },
    [boundRecipe, meetingTitle, queryClient, seriesKey],
  );

  const backToList = useCallback(() => {
    requestSeq.current++; // orphan any in-flight run
    setRunning(null);
    setOutput(null);
    setRunError(null);
  }, []);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    if (!name || !prompt) return;
    try {
      const next = draft.id
        ? await updateRecipe(draft.id, name, prompt, draft.scope)
        : await addRecipe(name, prompt, draft.scope);
      queryClient.setQueryData(["recipes"], next);
      setDraft(null);
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  }, [draft, queryClient]);

  const deleteDraft = useCallback(async () => {
    if (!draft?.id) return;
    try {
      const next = await deleteRecipe(draft.id);
      queryClient.setQueryData(["recipes"], next);
      setDraft(null);
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  }, [draft, queryClient]);

  if (!isOpen) return null;

  const showingResult = output !== null || runError !== null || running !== null;

  // Scope-field validation (UX audit): the same chip feedback the palette
  // gives for this grammar — malformed dates show as ignored, and a scope
  // with no recognized filters is called out instead of silently becoming
  // prompt text.
  const scopeDraft = draft?.scope.trim() ?? "";
  const scopeChips = scopeDraft ? extractFilterChips(scopeDraft) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh] backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Recipes"
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden glass-float rounded-xl"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <BookOpen size={14} className="shrink-0 text-accent" />
          <span className="text-sm font-semibold text-text-primary">Recipes</span>
          <span className="hidden text-footnote text-text-muted sm:inline">
            saved prompts, run on this meeting
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted transition-colors hover:text-text-primary"
            title="Close recipes"
            aria-label="Close recipes"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {showingResult ? (
            /* ---- Run result (or in-flight) ---- */
            <div className="px-4 py-3" aria-live="polite">
              <span className="mb-2 block text-footnote font-semibold uppercase tracking-wider text-text-muted">
                {(running ?? output?.recipe ?? runError?.recipe)?.name}
              </span>
              {running && (
                <div className="flex items-center gap-2 py-2 text-sm text-text-muted" role="status">
                  <Loader2 size={14} className="animate-spin" />
                  Running…
                </div>
              )}
              {runError && (
                <div className="rounded-lg bg-recording/10 px-3 py-2 text-sm text-recording" role="alert">
                  {runError.message}
                </div>
              )}
              {output && (
                <p className="whitespace-pre-wrap text-body-sm leading-relaxed text-text-primary">
                  {output.text}
                </p>
              )}
              {!running && (
                <div className="mt-3 flex items-center gap-2">
                  {output && (
                    <button
                      type="button"
                      onClick={copyOutput}
                      className="btn btn-primary"
                    >
                      <Copy size={12} />
                      Copy
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={backToList}
                    className="btn btn-secondary"
                  >
                    Run another
                  </button>
                  {output && seriesKey && (
                    <button
                      type="button"
                      onClick={() => toggleSeriesBinding(output.recipe)}
                      className="btn btn-secondary"
                      title="Auto-run this recipe whenever a meeting in this series completes"
                    >
                      <Repeat size={12} />
                      {boundRecipe?.id === output.recipe.id ? "Stop auto-run" : "Auto-run for this series"}
                    </button>
                  )}
                  <span className="ml-auto text-footnote text-text-muted">
                    Not saved anywhere. Copy what you need.
                  </span>
                </div>
              )}
            </div>
          ) : draft ? (
            /* ---- Inline add/edit form (settings-grade, spartan) ---- */
            <div className="space-y-2 px-4 py-3">
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Recipe name"
                aria-label="Recipe name"
                maxLength={80}
                className="w-full rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <textarea
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                placeholder="Prompt: what should the AI do with this meeting?"
                aria-label="Recipe prompt"
                rows={5}
                className="w-full resize-y rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-body-sm leading-relaxed text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              {/* QA audit P3-9a: the placeholder vocabulary was undocumented —
                  especially {{attendees}}, which puts calendar names/emails
                  into the prompt sent to your AI provider. */}
              <p className="text-footnote text-text-muted">
                The transcript and notes are included automatically. Optional
                placeholders: {"{{title}}"}, {"{{date}}"}, and {"{{attendees}}"}.
                The last sends this meeting&apos;s calendar attendee names to your
                AI provider, only if you use it.
              </p>
              <input
                type="text"
                value={draft.scope}
                onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
                placeholder="Scope (optional): folder:ClientX speaker:Amy after:2026-03"
                aria-label="Recipe scope filters"
                maxLength={200}
                className="w-full rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-body-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              {scopeDraft && (
                <>
                  {scopeChips.length > 0 ? (
                    <FilterChips chips={scopeChips} />
                  ) : (
                    <p className="m-0 text-footnote text-warning" role="status">
                      No filters recognized. This text would go into the
                      prompt instead of scoping which meetings are searched.
                    </p>
                  )}
                  <p
                    className="m-0 truncate font-mono text-footnote text-text-muted"
                    title={FILTER_HINT}
                  >
                    {FILTER_HINT}
                  </p>
                </>
              )}
              <p className="text-footnote text-text-muted">
                Leave the scope empty to run on the open meeting. With filters,
                the recipe runs across your recent meetings, the same retrieval as
                Ask AI&apos;s All-meetings mode, scoped by the filters.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveDraft}
                  disabled={!draft.name.trim() || !draft.prompt.trim()}
                  className="btn btn-primary"
                >
                  Save recipe
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
                {draft.id && (
                  <button
                    type="button"
                    onClick={deleteDraft}
                    className="ml-auto flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs text-recording transition-colors hover:bg-recording/10"
                  >
                    Delete recipe
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* ---- Recipe cards ---- */
            <div className="px-2 py-2">
              {recipesLoading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-text-muted" role="status">
                  <Loader2 size={14} className="animate-spin" />
                  Loading recipes…
                </div>
              ) : (
                <>
                  {recipes.map((recipe) => (
                    <div
                      key={recipe.id}
                      className="group flex items-start gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-bg-hover"
                    >
                      <button
                        type="button"
                        onClick={() => runRecipe(recipe)}
                        className="flex min-w-0 flex-1 items-start gap-2 py-1 text-left"
                        aria-label={`Run recipe: ${recipe.name}`}
                        title={recipe.prompt}
                      >
                        <Play size={11} className="mt-1 shrink-0 text-accent" />
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center gap-1.5 text-sm text-text-primary">
                            <span className="truncate">{recipe.name}</span>
                            {recipe.scope?.trim() && (
                              <span
                                className="shrink-0 rounded bg-bg-tertiary px-1 py-px text-footnote text-text-muted"
                                title={`Runs across meetings: ${recipe.scope}`}
                              >
                                {recipe.scope}
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-footnote text-text-muted">
                            {recipe.prompt}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            id: recipe.id,
                            name: recipe.name,
                            prompt: recipe.prompt,
                            scope: recipe.scope ?? "",
                          })
                        }
                        className="mt-1.5 shrink-0 rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
                        aria-label={`Edit recipe: ${recipe.name}`}
                        title="Edit recipe"
                      >
                        <Pencil size={11} />
                      </button>
                    </div>
                  ))}
                  {recipes.length === 0 && (
                    <p className="px-2 py-3 text-sm text-text-muted">
                      No recipes yet. Add one below.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer — new recipe entry point (list view only) */}
        {!showingResult && !draft && (
          <div className="border-t border-border px-2 py-1.5">
            <button
              type="button"
              onClick={() => setDraft({ id: null, name: "", prompt: "", scope: "" })}
              className="btn btn-ghost"
            >
              <Plus size={12} />
              New recipe
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
