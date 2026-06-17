import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecipesPanel } from "../../components/meeting/RecipesPanel";
import { invoke, resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";
import { SEED_RECIPES } from "../../lib/recipes";

const ANSWER = "Subject: Follow-up\n\nThanks all — action items below.";

function renderPanel(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RecipesPanel meetingId="m1" meetingTitle="Weekly Sync" isOpen onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe("RecipesPanel (plan v9 #6)", () => {
  const chatCalls: Array<Record<string, unknown> | undefined> = [];

  beforeEach(() => {
    chatCalls.length = 0;
    // get_setting/set_setting fall through to the mock's settings map, so
    // the panel's first load exercises the real seed-on-absent path.
    resetTauriCoreMock({
      commandHandlers: {
        chat_with_meeting: (args) => {
          chatCalls.push(args);
          return ANSWER;
        },
      },
    });
  });

  it("renders the seeded recipe cards", async () => {
    renderPanel();

    for (const seed of SEED_RECIPES) {
      expect(
        await screen.findByRole("button", { name: `Run recipe: ${seed.name}` }),
      ).toBeInTheDocument();
    }
  });

  it("runs a recipe via chat_with_meeting with the recipe prompt and meeting id, then offers Copy", async () => {
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "Run recipe: Draft follow-up email" }),
    );

    // The run IS an Ask AI question: this meeting + the recipe's prompt.
    expect(await screen.findByText(/Thanks all — action items below\./)).toBeInTheDocument();
    expect(chatCalls).toEqual([{ meetingId: "m1", question: SEED_RECIPES[0].prompt }]);

    // Transient output: Copy puts it on the clipboard; nothing touches notes.
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_clipboard", { text: ANSWER }),
    );
    expect(screen.getByText(/Not saved anywhere/)).toBeInTheDocument();

    // "Run another" returns to the card list.
    fireEvent.click(screen.getByRole("button", { name: "Run another" }));
    expect(
      await screen.findByRole("button", { name: "Run recipe: Decision log" }),
    ).toBeInTheDocument();
  });

  it("surfaces a run error and recovers back to the list", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        chat_with_meeting: () => Promise.reject("error sending request"),
      },
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Run recipe: Decision log" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't reach the AI provider/);
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run another" }));
    expect(
      await screen.findByRole("button", { name: "Run recipe: Q&A extract" }),
    ).toBeInTheDocument();
  });

  it("adds a recipe inline and shows its card", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Run recipe: Q&A extract" });

    fireEvent.click(screen.getByRole("button", { name: "New recipe" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Recipe name" }), {
      target: { value: "Standup blurb" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Recipe prompt" }), {
      target: { value: "Two sentences for tomorrow's standup." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));

    expect(
      await screen.findByRole("button", { name: "Run recipe: Standup blurb" }),
    ).toBeInTheDocument();
    // Persisted to the settings k/v library, not just local state.
    const writes = invoke.mock.calls.filter(
      ([cmd, args]) => cmd === "set_setting" && (args as { key?: string })?.key === "recipes",
    );
    expect(String((writes[writes.length - 1]?.[1] as { value?: string })?.value)).toContain(
      "Standup blurb",
    );
  });

  it("validates the scope field with the palette's filter chips (UX audit)", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Run recipe: Q&A extract" });

    fireEvent.click(screen.getByRole("button", { name: "New recipe" }));
    const scope = screen.getByRole("textbox", { name: "Recipe scope filters" });

    // Recognized filters render as chips; a malformed date is flagged as
    // ignored instead of silently doing nothing at run time.
    fireEvent.change(scope, { target: { value: "speaker:amy after:March" } });
    const chips = await screen.findByTestId("filter-chips");
    expect(chips).toHaveTextContent("speaker:");
    expect(chips).toHaveTextContent("amy");
    expect(chips).toHaveTextContent("ignored"); // after:March → dropped by the backend
    // The palette's one-line grammar reminder sits under the field (RTL
    // collapses the hint's double spaces during text normalization).
    expect(screen.getByText(/speaker:name folder:name/)).toBeInTheDocument();

    // A scope with no recognized filters gets an explicit call-out.
    fireEvent.change(scope, { target: { value: "folder ClientX" } });
    expect(screen.queryByTestId("filter-chips")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/No filters recognized/);

    // An empty scope shows neither chips nor warnings.
    fireEvent.change(scope, { target: { value: "" } });
    expect(screen.queryByTestId("filter-chips")).toBeNull();
    expect(screen.queryByText(/No filters recognized/)).toBeNull();
  });

  it("edits and deletes a recipe from the inline editor", async () => {
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "Edit recipe: Decision log" }),
    );
    const nameInput = screen.getByRole("textbox", { name: "Recipe name" });
    expect(nameInput).toHaveValue("Decision log");
    fireEvent.change(nameInput, { target: { value: "Decisions only" } });
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    expect(
      await screen.findByRole("button", { name: "Run recipe: Decisions only" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit recipe: Decisions only" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete recipe" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Run recipe: Decisions only" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Esc closes the panel via the overlay ladder", async () => {
    const onClose = renderPanel();
    await screen.findByRole("dialog", { name: "Recipes" });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
