import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptDrawer } from "../../components/meeting/TranscriptDrawer";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getTranscriptByMeeting: vi.fn(),
    listSpeakerLabels: vi.fn(),
    listSpeakerLabelsForMeeting: vi.fn(),
    rediarizeTranscript: vi.fn(),
    upsertSpeakerLabel: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: vi.fn((path: string) => path),
}));

vi.mock("../../lib/ipc", () => ({
  ipc: ipcMock,
}));

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TranscriptDrawer meetingId="meeting-1" isOpen onClose={vi.fn()} meetingStatus="complete" />
    </QueryClientProvider>,
  );
}

describe("TranscriptDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMock.getTranscriptByMeeting.mockResolvedValue(null);
    ipcMock.listSpeakerLabels.mockResolvedValue([]);
    ipcMock.listSpeakerLabelsForMeeting.mockResolvedValue([]);
    ipcMock.rediarizeTranscript.mockResolvedValue("ok");
    ipcMock.upsertSpeakerLabel.mockResolvedValue(undefined);
  });

  it("renders a named drawer with labelled transcript search", async () => {
    renderDrawer();

    expect(screen.getByRole("complementary", { name: "Transcript drawer" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search transcript")).toBeInTheDocument();
    expect(await screen.findByText("No transcript")).toBeInTheDocument();
  });

  it("uses pressed state for transcript and speaker tabs", () => {
    renderDrawer();

    const transcriptTab = screen.getByRole("button", { name: "Transcript" });
    const speakersTab = screen.getByRole("button", { name: "Speakers" });
    expect(transcriptTab).toHaveAttribute("aria-pressed", "true");
    expect(speakersTab).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(speakersTab);

    expect(transcriptTab).toHaveAttribute("aria-pressed", "false");
    expect(speakersTab).toHaveAttribute("aria-pressed", "true");
  });
});
