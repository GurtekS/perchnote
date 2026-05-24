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

    expect(await screen.findByText("Default Template")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "AI" }));

    expect(await screen.findByText("Anthropic API")).toBeInTheDocument();
    expect(await screen.findByText("no key")).toBeInTheDocument();

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

    expect(await screen.findByText("Perchnote v0.1.0")).toBeInTheDocument();
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
      fireEvent.click(await screen.findByRole("button", { name: /Export all data/i }));

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

  it("accepts only known settings sections for setup repair routing", () => {
    expect(isSettingsSection("audio")).toBe(true);
    expect(isSettingsSection("setup")).toBe(true);
    expect(isSettingsSection("calendar")).toBe(true);
    expect(isSettingsSection("billing")).toBe(false);
    expect(isSettingsSection(["audio"])).toBe(false);
    expect(isSettingsSection(null)).toBe(false);
  });
});
