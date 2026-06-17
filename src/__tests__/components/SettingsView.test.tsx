import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView, type SettingsSection } from "../../components/settings/SettingsView";
import { isSettingsSection } from "../../routes/settings";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

function renderSettings(props: {
  initialSection?: SettingsSection;
  onRunSetup?: () => void;
  onSectionChange?: (section: SettingsSection) => void;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <SettingsView {...props} />
    </QueryClientProvider>,
  );
}

describe("SettingsView", () => {
  beforeEach(() => {
    resetTauriCoreMock();
  });

  it("renders settings panels with deterministic local Tauri mocks", async () => {
    renderSettings();

    expect(await screen.findByText("Accent Color")).toBeInTheDocument();
    // Moved out of General (UX audit junk drawer): AI-generation settings
    // live in AI, the default template in Templates.
    expect(screen.queryByText("Default Template")).not.toBeInTheDocument();
    expect(screen.queryByText("Instant recap")).not.toBeInTheDocument();
    expect(screen.queryByText("My Tasks Only")).not.toBeInTheDocument();
    expect(screen.queryByText("About You")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "AI" }));

    expect(await screen.findByText("Anthropic API")).toBeInTheDocument();
    expect(await screen.findByText("no key")).toBeInTheDocument();
    // The Generation subsection groups the provider-independent behavior.
    expect(screen.getByText("Generation")).toBeInTheDocument();
    expect(screen.getByText("Instant recap")).toBeInTheDocument();
    expect(screen.getByText("My Tasks Only")).toBeInTheDocument();
    expect(screen.getByText("About You")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Templates" }));

    expect(await screen.findByText("Default Template")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default template" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));

    expect(await screen.findByText("ICS Calendar Feeds")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Connect/ }).length).toBeGreaterThan(0);
  });

  it("shows readiness failures in AI and Audio without external service calls", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        is_ollama_running: () => {
          throw new Error("ollama unavailable");
        },
        is_apple_ai_available: () => {
          throw new Error("apple status unavailable");
        },
        list_audio_devices: () => {
          throw new Error("audio permission unavailable");
        },
        list_whisper_models: () => {
          throw new Error("model folder unavailable");
        },
      },
    });

    renderSettings({ initialSection: "ai" });

    await waitFor(() => {
      expect(screen.getAllByText("check failed")).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Audio" }));

    expect(await screen.findByText("Audio device check failed")).toBeInTheDocument();
    expect(await screen.findByText("Transcription model check failed")).toBeInTheDocument();
  });

  it("shows calendar readiness without exposing saved secrets", async () => {
    resetTauriCoreMock({
      settings: {
        google_client_id: "saved-google-client",
        google_client_secret: "saved-google-secret",
      },
      microsoftConnected: true,
      icsUrls: ["https://example.com/team.ics"],
    });

    renderSettings({ initialSection: "calendar" });

    expect(await screen.findByText("2 configured")).toBeInTheDocument();
    expect(screen.getByText("credentials saved")).toBeInTheDocument();
    expect(screen.getAllByText("connected").length).toBeGreaterThan(0);
    expect(screen.getByText("1 feed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const secretInput = screen.getByPlaceholderText("Client Secret");
    expect(secretInput).toHaveAttribute("type", "password");
    expect(screen.queryByDisplayValue("saved-google-secret")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Authorize" })).not.toBeDisabled();
  });

  it("names calendar feed removal with a compact stable display label", async () => {
    resetTauriCoreMock({
      icsUrls: [
        "https://calendar.google.com/calendar/ical/team/private-long-feed/basic.ics",
      ],
    });

    renderSettings({ initialSection: "calendar" });

    expect(await screen.findByText("1 configured")).toBeInTheDocument();
    expect(screen.getByText("1 feed")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Remove calendar feed calendar\.google\.com\/calendar\/ical\/team/i,
      }),
    );

    expect(await screen.findByText("no feeds")).toBeInTheDocument();
  });

  it("renders setup replay and repair navigation using settings panel patterns", async () => {
    const onRunSetup = vi.fn();
    const onSectionChange = vi.fn();
    renderSettings({ onRunSetup, onSectionChange });

    fireEvent.click(screen.getByRole("button", { name: "Setup Guide" }));

    expect(screen.getByRole("heading", { name: "Setup Guide" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Replay setup guide" }));
    expect(onRunSetup).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Fix audio setupChoose a microphone/i }));

    expect(onSectionChange).toHaveBeenCalledWith("audio");
    expect(await screen.findByText("Select the microphone to use for recording meetings.")).toBeInTheDocument();
  });

  it("uses Perchnote product copy in General settings", async () => {
    renderSettings();

    // Version comes from getVersion() at runtime (was a hardcoded v0.1.0
    // that survived four releases — friction audit #15).
    expect(await screen.findByText(/^Perchnote/)).toBeInTheDocument();
    expect(screen.queryByText(/v0\.1\.0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Meeting Assistant/i)).not.toBeInTheDocument();
  });

  it("exports backups with a Perchnote filename prefix", async () => {
    const originalCreateElement = document.createElement.bind(document);
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    let anchor: HTMLAnchorElement | null = null;
    const anchorClick = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:perchnote-backup"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === "a") {
        anchor = element as HTMLAnchorElement;
        Object.defineProperty(anchor, "click", { configurable: true, value: anchorClick });
      }
      return element;
    });

    try {
      renderSettings();
      fireEvent.click(screen.getByRole("button", { name: "Data" }));
      fireEvent.click(await screen.findByRole("button", { name: /Export JSON/i }));

      await waitFor(() => {
        expect(anchorClick).toHaveBeenCalledTimes(1);
      });
      expect(anchor?.download).toMatch(/^perchnote-backup-\d{4}-\d{2}-\d{2}\.json$/);
    } finally {
      createElement.mockRestore();
      if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("writes and then verifies a .perchnote archive from the Data panel", async () => {
    const exportHandler = vi.fn(() => ({
      path: "/Users/mock/Desktop/Perchnote-backup-2026-06-09.perchnote",
      files: 4,
      bytes: 5163,
    }));
    const verifyHandler = vi.fn(() => ({ ok: true, checked: 4, problems: [] }));
    resetTauriCoreMock({
      commandHandlers: {
        export_backup_archive: exportHandler,
        verify_backup_archive: verifyHandler,
      },
    });

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(await screen.findByRole("button", { name: /Full backup/i }));

    await waitFor(() => {
      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(verifyHandler).toHaveBeenCalledTimes(1);
    });
    // The verify call must target the file the export just wrote.
    expect(verifyHandler.mock.calls[0][0]).toMatchObject({
      path: "/Users/mock/Desktop/Perchnote-backup-2026-06-09.perchnote",
    });
    // Busy state resolves back to the idle label.
    expect(await screen.findByRole("button", { name: /Full backup/i })).toBeEnabled();
  });

  it("lists archives and stages a restore behind an explicit confirm", async () => {
    const listHandler = vi.fn(() => [
      { path: "/Users/mock/Desktop/Perchnote-backup-2026-06-09.perchnote", bytes: 2048, modified: "2026-06-09T22:00:00Z" },
    ]);
    const restoreHandler = vi.fn(() => 4);
    resetTauriCoreMock({
      commandHandlers: {
        list_backup_archives: listHandler,
        restore_backup_archive: restoreHandler,
        restart_app: vi.fn(),
      },
    });

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(await screen.findByRole("button", { name: /Restore from backup/i }));

    // Picking an archive opens the danger confirm; nothing restores yet.
    fireEvent.click(await screen.findByRole("button", { name: /Perchnote-backup-2026-06-09/ }));
    expect(restoreHandler).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Restore & Restart/i }));
    await waitFor(() => {
      expect(restoreHandler).toHaveBeenCalledTimes(1);
    });
    expect(restoreHandler.mock.calls[0][0]).toMatchObject({
      path: "/Users/mock/Desktop/Perchnote-backup-2026-06-09.perchnote",
    });
  });

  it("gates the Apple Speech engine option on availability (plan v9 #12)", async () => {
    renderSettings({ initialSection: "audio" });

    // Default host: SpeechTranscriber unavailable → apple option disabled,
    // whisper selected.
    const picker = await screen.findByRole("combobox", { name: "Transcription engine" });
    expect(picker).toHaveValue("whisper");
    expect(
      screen.getByRole("option", { name: /Apple Speech \(macOS 26\+, beta\)/ }),
    ).toBeDisabled();
  });

  it("persists the Apple Speech engine choice when the stack is available", async () => {
    resetTauriCoreMock({ speechEngineAvailable: true });
    renderSettings({ initialSection: "audio" });

    const picker = await screen.findByRole("combobox", { name: "Transcription engine" });
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Apple Speech \(macOS 26\+, beta\)/ }),
      ).not.toBeDisabled();
    });

    fireEvent.change(picker, { target: { value: "apple" } });

    await waitFor(() => {
      expect(picker).toHaveValue("apple");
    });
    // The version-scope caveat is stated right next to the picker.
    expect(
      screen.getByText(/Applies to imports and re-transcription in this version/),
    ).toBeInTheDocument();
  });

  it("accepts only known settings sections for setup repair routing", () => {
    expect(isSettingsSection("audio")).toBe(true);
    expect(isSettingsSection("setup")).toBe(true);
    expect(isSettingsSection("calendar")).toBe(true);
    expect(isSettingsSection("billing")).toBe(false);
    expect(isSettingsSection(["audio"])).toBe(false);
    expect(isSettingsSection(null)).toBe(false);
  });
});
