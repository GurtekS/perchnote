import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AskAIOverlay } from "../../components/meeting/AskAIOverlay";
import { CommandPalette } from "../../components/shared/CommandPalette";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

const { navigateMock, matchRouteMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  matchRouteMock: vi.fn(() => false),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useMatchRoute: () => matchRouteMock,
}));

function renderWithQuery(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function AskAIHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Ask launcher
      </button>
      <AskAIOverlay meetingId="meeting-1" isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe("modal overlays", () => {
  beforeEach(() => {
    resetTauriCoreMock({
      commandHandlers: {
        list_chat_messages: () => [],
        list_meetings: () => [],
      },
    });
    navigateMock.mockReset();
    matchRouteMock.mockReset();
    matchRouteMock.mockReturnValue(false);
  });

  it("opens Command Palette as a labelled dialog and restores focus on Escape", async () => {
    renderWithQuery(
      <>
        <button type="button">Palette launcher</button>
        <CommandPalette />
      </>,
    );
    const launcher = screen.getByRole("button", { name: "Palette launcher" });
    launcher.focus();

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Search commands and meetings" })).toHaveFocus();
    });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(launcher).toHaveFocus();
    });
  });

  it("opens Ask AI as a labelled dialog and restores focus on Escape", async () => {
    renderWithQuery(<AskAIHarness />);
    const launcher = screen.getByRole("button", { name: "Ask launcher" });
    launcher.focus();

    fireEvent.click(launcher);

    const dialog = await screen.findByRole("dialog", { name: "Ask AI" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Ask about this meeting" })).toHaveFocus();
    });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Ask AI" })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(launcher).toHaveFocus();
    });
  });
});
