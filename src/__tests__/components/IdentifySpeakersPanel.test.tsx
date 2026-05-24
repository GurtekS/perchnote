import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IdentifySpeakersPanel } from "../../components/meeting/IdentifySpeakersPanel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "unknown_speakers_for_meeting") {
      return [{
        speaker_key: "Speaker 1",
        longest_start_ms: 1000, longest_end_ms: 9000,
        total_seconds: 30,
        suggested_name: "Alice", suggested_similarity: 0.84,
      }];
    }
    if (cmd === "get_recording_url") return "/fake/path.wav";
    return null;
  }),
  convertFileSrc: vi.fn((p: string) => p),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

function withQuery(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("IdentifySpeakersPanel", () => {
  it("renders one row per unknown speaker with the suggested name pre-filled", async () => {
    render(withQuery(<IdentifySpeakersPanel meetingId="m1" />));
    expect(await screen.findByText(/Speaker 1/)).toBeInTheDocument();
    const input = await screen.findByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Alice");
  });
});
