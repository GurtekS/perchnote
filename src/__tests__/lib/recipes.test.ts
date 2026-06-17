import { beforeEach, describe, expect, it } from "vitest";
import { invoke, resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";
import {
  addRecipe,
  deleteRecipe,
  getSeriesRecipe,
  loadRecipes,
  normalizeSeriesTitle,
  saveRecipes,
  SEED_RECIPES,
  seriesRecipeKey,
  setSeriesRecipe,
  updateRecipe,
} from "../../lib/recipes";

const SEED_NAMES = [
  "Draft follow-up email",
  "Status update for my manager",
  "Decision log",
  "Q&A extract",
];

/** How many times the library was written to settings. */
function recipeWrites(): number {
  return invoke.mock.calls.filter(
    ([cmd, args]) => cmd === "set_setting" && (args as { key?: string })?.key === "recipes",
  ).length;
}

describe("recipes library (plan v9 #6)", () => {
  beforeEach(() => {
    resetTauriCoreMock(); // no `recipes` key — the mock's settings map starts empty
  });

  it("seeds the four defaults on first read and persists them", async () => {
    const recipes = await loadRecipes();

    expect(recipes.map((r) => r.name)).toEqual(SEED_NAMES);
    expect(recipes.every((r) => r.id && r.prompt.length > 0)).toBe(true);
    expect(recipeWrites()).toBe(1);

    // Second read is served from storage — no reseed, same content.
    expect(await loadRecipes()).toEqual(recipes);
    expect(recipeWrites()).toBe(1);
  });

  it("round-trips add → update → delete through get/set_setting", async () => {
    const afterAdd = await addRecipe("  Retro themes  ", "  Pull out recurring retro themes.  ");
    expect(afterAdd).toHaveLength(SEED_RECIPES.length + 1);
    const added = afterAdd[afterAdd.length - 1];
    // Inputs are trimmed and the id is generated.
    expect(added).toMatchObject({ name: "Retro themes", prompt: "Pull out recurring retro themes." });
    expect(added.id.length).toBeGreaterThan(0);
    // A fresh read comes back from settings, not from memory.
    expect(await loadRecipes()).toEqual(afterAdd);

    const afterUpdate = await updateRecipe(added.id, "Retro insights", "Updated prompt");
    expect(afterUpdate.find((r) => r.id === added.id)).toMatchObject({
      name: "Retro insights",
      prompt: "Updated prompt",
    });
    // Untouched seeds survive the update unchanged.
    expect(afterUpdate.slice(0, SEED_RECIPES.length)).toEqual([...SEED_RECIPES]);
    expect(await loadRecipes()).toEqual(afterUpdate);

    const afterDelete = await deleteRecipe(added.id);
    expect(afterDelete.map((r) => r.name)).toEqual(SEED_NAMES);
    expect(await loadRecipes()).toEqual(afterDelete);
  });

  it("reseeds when the stored value is malformed JSON", async () => {
    resetTauriCoreMock({ settings: { recipes: "{ definitely not json" } });

    const recipes = await loadRecipes();
    expect(recipes.map((r) => r.name)).toEqual(SEED_NAMES);
    // The corrupt value was replaced — the next read needs no second write.
    expect(recipeWrites()).toBe(1);
    expect(await loadRecipes()).toEqual(recipes);
    expect(recipeWrites()).toBe(1);
  });

  it("reseeds when the stored JSON is not a recipe array", async () => {
    resetTauriCoreMock({ settings: { recipes: '[{"id":1,"name":2,"prompt":null}]' } });
    expect((await loadRecipes()).map((r) => r.name)).toEqual(SEED_NAMES);

    resetTauriCoreMock({ settings: { recipes: '{"id":"x","name":"y","prompt":"z"}' } });
    expect((await loadRecipes()).map((r) => r.name)).toEqual(SEED_NAMES);
  });

  it("respects a deliberately emptied library — only absence/corruption seeds", async () => {
    await saveRecipes([]);
    expect(await loadRecipes()).toEqual([]);
  });

  // --- Scoped recipes (plan v10 #8) ---

  it("round-trips an optional scope, normalized and clearable", async () => {
    await saveRecipes([]);
    let lib = await addRecipe("Client digest", "Summarize.", "  folder:ClientX after:2026-03  ");
    expect(lib[0].scope).toBe("folder:ClientX after:2026-03");

    // Whitespace-only scope is stored as ABSENT, not empty.
    lib = await addRecipe("Plain", "Do.", "   ");
    expect("scope" in lib[1]).toBe(false);

    // Clearing the scope on update removes the field.
    lib = await updateRecipe(lib[0].id, "Client digest", "Summarize.", "");
    expect("scope" in lib[0]).toBe(false);

    // Stored v1 recipes (no scope field) still load — and a wrong-typed
    // scope is corruption, which reseeds.
    expect((await loadRecipes()).map((r) => r.name)).toEqual(["Client digest", "Plain"]);
    resetTauriCoreMock({
      settings: { recipes: '[{"id":"a","name":"n","prompt":"p","scope":42}]' },
    });
    expect((await loadRecipes()).map((r) => r.name)).toEqual(SEED_NAMES);
  });

  // --- Per-series auto-run (plan v10 #8, second half) ---

  it("mirrors the backend's series-title normalization and exclusions", () => {
    // Same rules as queries.rs normalize_series_title + its callers:
    // lowercase, non-letters → space, collapse; <2 words and the
    // untitled default are not a series.
    expect(normalizeSeriesTitle("Weekly Sync — Q2 (1:1)")).toBe("weekly sync q");
    expect(seriesRecipeKey("Weekly Sync")).toBe("series_recipe:weekly sync");
    expect(seriesRecipeKey("Standup")).toBeNull();
    expect(seriesRecipeKey("Untitled Meeting")).toBeNull();
    expect(seriesRecipeKey("  ")).toBeNull();
  });

  it("binds, resolves, and clears a series recipe — stale bindings read as none", async () => {
    const lib = await loadRecipes(); // seeds
    await setSeriesRecipe("Weekly Sync", lib[0].id);
    expect((await getSeriesRecipe("Weekly Sync"))?.id).toBe(lib[0].id);
    // A different series is unbound; a non-series title resolves null.
    expect(await getSeriesRecipe("Board Review")).toBeNull();
    expect(await getSeriesRecipe("Standup")).toBeNull();
    // Deleting the bound recipe leaves a stale id → reads as none.
    await deleteRecipe(lib[0].id);
    expect(await getSeriesRecipe("Weekly Sync")).toBeNull();
    // Clearing writes an empty binding.
    await setSeriesRecipe("Weekly Sync", null);
    expect(await getSeriesRecipe("Weekly Sync")).toBeNull();
  });
});
