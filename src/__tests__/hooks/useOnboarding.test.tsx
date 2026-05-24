import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOnboarding } from "../../hooks/useOnboarding";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

function Harness() {
  const { completeOnboarding, isComplete, isLoading, markStepViewed, progress } = useOnboarding();

  return (
    <div>
      <button type="button" onClick={() => void completeOnboarding()}>
        {isLoading ? "loading" : isComplete ? "complete" : "incomplete"}
      </button>
      <button type="button" onClick={() => void markStepViewed("ai")}>
        mark ai
      </button>
      <p>
        {progress.viewedAudioSetup ? "audio viewed" : "audio not viewed"} /{" "}
        {progress.viewedAiSetup ? "ai viewed" : "ai not viewed"} /{" "}
        {progress.resumeStep ? `resume ${progress.resumeStep}` : "no resume step"}
      </p>
    </div>
  );
}

function renderHookHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("useOnboarding", () => {
  beforeEach(() => {
    resetTauriCoreMock();
  });

  it("invalidates and refetches onboarding completion after marking first-run complete", async () => {
    renderHookHarness();

    expect(await screen.findByRole("button", { name: "incomplete" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "incomplete" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "complete" })).toBeInTheDocument();
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
      key: "onboarding_completed",
      value: "true",
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
      key: "onboarding_viewed_audio_setup",
      value: "true",
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
      key: "onboarding_viewed_ai_setup",
      value: "true",
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
      key: "onboarding_viewed_calendar_setup",
      value: "true",
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
      key: "onboarding_resume_step",
      value: "start",
    });

    const completionReads = mockInvoke.mock.calls.filter(
      ([command, args]) => command === "get_setting" && args?.key === "onboarding_completed",
    );
    expect(completionReads.length).toBeGreaterThanOrEqual(2);
  });

  it("loads and persists non-sensitive setup milestone progress", async () => {
    resetTauriCoreMock({
      settings: {
        onboarding_viewed_audio_setup: "true",
        onboarding_resume_step: "audio",
      },
    });
    renderHookHarness();

    expect(await screen.findByText("audio viewed / ai not viewed / resume audio")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "mark ai" }));

    await waitFor(() => {
      expect(screen.getByText("audio viewed / ai viewed / resume ai")).toBeInTheDocument();
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
      key: "onboarding_resume_step",
      value: "ai",
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_setting", {
      key: "onboarding_viewed_ai_setup",
      value: "true",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("set_setting", {
      key: "anthropic_api_key",
      value: expect.any(String),
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("set_setting", {
      key: "google_client_secret",
      value: expect.any(String),
    });
  });
});
