import { ipc } from "./ipc";

/**
 * Recipes (plan v9 #6): the user's saved-prompt library, run against the
 * current meeting through the same chat_with_meeting path as Ask AI — same
 * fenced transcript, same system preamble, no new retrieval surface.
 *
 * Storage is one JSON array under the settings k/v key `recipes` (no
 * migration). The library is seeded client-side with four defaults the
 * first time it's read; malformed or wrong-shaped stored JSON also
 * reseeds rather than wedging the panel. A deliberately emptied library
 * (`[]`) is respected — only absence/corruption seeds.
 */
export interface Recipe {
  id: string;
  name: string;
  prompt: string;
  /** Optional filter-grammar scope (plan v10 #8), e.g. "folder:ClientX
   *  after:2026-03". Empty/absent = run against the current meeting (v1
   *  behavior); present = run across recent meetings with the typed
   *  filters scoping retrieval, exactly like Ask AI's All-meetings mode.
   *  v1-stored recipes simply lack the field. */
  scope?: string;
}

export const RECIPES_SETTINGS_KEY = "recipes";

export const SEED_RECIPES: readonly Recipe[] = [
  {
    id: "seed-follow-up-email",
    name: "Draft follow-up email",
    prompt:
      "Draft a short, professional follow-up email about this meeting, written from my perspective to the other attendees. Summarize what was agreed in two or three sentences, then list the action items as bullets with an owner for each. Keep it under 150 words; output a subject line and the body, nothing else.",
  },
  {
    id: "seed-status-update",
    name: "Status update for my manager",
    prompt:
      "Write a status update for my manager based on this meeting: exactly three bullets, one sentence each, focused on outcomes and decisions — not process and not who said what. Plain text, no preamble.",
  },
  {
    id: "seed-decision-log",
    name: "Decision log",
    prompt:
      "Extract every decision made in this meeting. For each one give the decision, who made or owns it, and why (the stated rationale). Finish with any open questions that were raised but not resolved. Short bullets grouped under 'Decisions' and 'Open questions'.",
  },
  {
    id: "seed-qa-extract",
    name: "Q&A extract",
    prompt:
      "List the questions asked in this meeting and the answers given, attributed to speakers where the transcript identifies them. Format each as 'Q (asker): …' followed by 'A (answerer): …'. Put questions that never got an answer at the end under 'Unanswered'.",
  },
];

function isRecipe(value: unknown): value is Recipe {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.name === "string" &&
    typeof r.prompt === "string" &&
    (r.scope === undefined || typeof r.scope === "string")
  );
}

export function newRecipeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Load the library. Absent key → seed the four defaults (best-effort
 * persist — the seeds are returned even if the write fails). Malformed
 * JSON or entries that don't look like recipes → reseed the same way.
 */
export async function loadRecipes(): Promise<Recipe[]> {
  const stored = await ipc.getSetting(RECIPES_SETTINGS_KEY);
  if (stored != null && stored !== "") {
    try {
      const parsed: unknown = JSON.parse(stored);
      // An empty array is a valid, deliberately-emptied library.
      if (Array.isArray(parsed) && parsed.every(isRecipe)) return parsed;
    } catch {
      // corrupt JSON — fall through to reseed
    }
  }
  const seeds = SEED_RECIPES.map((r) => ({ ...r }));
  try {
    await saveRecipes(seeds);
  } catch {
    // Persisting the seeds is best-effort; the session still gets them.
  }
  return seeds;
}

export async function saveRecipes(recipes: Recipe[]): Promise<void> {
  await ipc.setSetting(RECIPES_SETTINGS_KEY, JSON.stringify(recipes));
}

/** A normalized scope value: trimmed, and absent rather than empty. */
function normalizeScope(scope?: string): string | undefined {
  const s = scope?.trim();
  return s ? s : undefined;
}

/** Append a recipe; returns the persisted library. */
export async function addRecipe(
  name: string,
  prompt: string,
  scope?: string,
): Promise<Recipe[]> {
  const next = [
    ...(await loadRecipes()),
    {
      id: newRecipeId(),
      name: name.trim(),
      prompt: prompt.trim(),
      ...(normalizeScope(scope) ? { scope: normalizeScope(scope) } : {}),
    },
  ];
  await saveRecipes(next);
  return next;
}

/** Rename/re-prompt/re-scope a recipe in place; unknown ids are a no-op save. */
export async function updateRecipe(
  id: string,
  name: string,
  prompt: string,
  scope?: string,
): Promise<Recipe[]> {
  const next = (await loadRecipes()).map((r) => {
    if (r.id !== id) return r;
    const { scope: _old, ...rest } = r;
    const normalized = normalizeScope(scope);
    return {
      ...rest,
      name: name.trim(),
      prompt: prompt.trim(),
      ...(normalized ? { scope: normalized } : {}),
    };
  });
  await saveRecipes(next);
  return next;
}

export async function deleteRecipe(id: string): Promise<Recipe[]> {
  const next = (await loadRecipes()).filter((r) => r.id !== id);
  await saveRecipes(next);
  return next;
}

// --- Per-series auto-run (plan v10 #8, second half) -------------------------
//
// One auto-run recipe per meeting series, stored as a settings row
// `series_recipe:<normalized title>` holding the recipe id — the same
// shape and normalization as the backend's series-template memory
// (queries.rs normalize_series_title), so the two features agree on what
// "the same series" means. The run itself happens in the frontend on the
// meeting-completed event; output is a dismissible card, never notes.

/** TS mirror of queries.rs normalize_series_title: lowercase, non-letters
 *  become spaces, whitespace collapsed. */
export function normalizeSeriesTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** The settings key for a title's series binding — null when the title is
 *  too generic to be a series (<2 words, or the untitled default), the
 *  same exclusions the backend applies. */
export function seriesRecipeKey(title: string): string | null {
  const key = normalizeSeriesTitle(title);
  if (key.split(" ").filter(Boolean).length < 2 || key === "untitled meeting") return null;
  return `series_recipe:${key}`;
}

/** The recipe bound to this title's series, if the binding still points at
 *  a recipe that exists (a deleted recipe's stale binding reads as none). */
export async function getSeriesRecipe(title: string): Promise<Recipe | null> {
  const key = seriesRecipeKey(title);
  if (!key) return null;
  const id = await ipc.getSetting(key);
  if (!id) return null;
  return (await loadRecipes()).find((r) => r.id === id) ?? null;
}

/** Bind (or with null, clear) this title's series auto-run recipe. */
export async function setSeriesRecipe(title: string, recipeId: string | null): Promise<void> {
  const key = seriesRecipeKey(title);
  if (!key) return;
  await ipc.setSetting(key, recipeId ?? "");
}
