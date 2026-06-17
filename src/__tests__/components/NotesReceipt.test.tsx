import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesReceipt, receiptModelLabel } from "../../components/meeting/NotesReceipt";
import { ipc, Note } from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({
  ipc: {
    getTranscriptSha: vi.fn().mockResolvedValue(null),
    restorePreviousNotes: vi.fn().mockResolvedValue(undefined),
  },
}));

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // wrapper (not inline JSX) so rerender() keeps the provider around the tree.
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
}

const GENERATED_DOC = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "current AI notes" }] }],
});

const PREVIOUS_DOC = JSON.stringify({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Old Decisions" }] },
    { type: "paragraph", content: [{ type: "text", text: "the earlier take" }] },
  ],
});

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    meeting_id: "m1",
    raw_content: "{}",
    generated_content: GENERATED_DOC,
    template_id: null,
    created_at: "2026-06-10T10:00:00Z",
    updated_at: "2026-06-10T10:00:00Z",
    generated_provider: "anthropic",
    generated_model: "claude-sonnet-4-6",
    generated_at: "2026-06-10T14:32:00Z",
    generated_transcript_sha: "sha-gen",
    generated_previous: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getTranscriptSha).mockResolvedValue(null);
});

describe("receipt line", () => {
  it("renders provider, model, and time from the receipt fields", () => {
    render(<NotesReceipt meetingId="m1" note={note()} />);
    const receipt = screen.getByTestId("notes-receipt");
    expect(receipt.textContent).toContain("Claude Sonnet");
    expect(receipt.textContent).toContain("from the transcript as of generation");
  });

  it("renders NOTHING for a note without receipts (pre-migration-18)", () => {
    // Old notes have generated_content but NULL receipt columns — the
    // receipt must be absent, never an empty shell.
    render(
      <NotesReceipt
        meetingId="m1"
        note={note({
          generated_provider: null,
          generated_model: null,
          generated_at: null,
          generated_transcript_sha: null,
        })}
      />,
    );
    expect(screen.queryByTestId("notes-receipt")).not.toBeInTheDocument();
  });

  it("renders NOTHING when there is no note or no AI notes at all", () => {
    const { rerender } = render(<NotesReceipt meetingId="m1" note={null} />);
    expect(screen.queryByTestId("notes-receipt")).not.toBeInTheDocument();
    rerender(<NotesReceipt meetingId="m1" note={note({ generated_content: null })} />);
    expect(screen.queryByTestId("notes-receipt")).not.toBeInTheDocument();
  });
});

describe("staleness badge", () => {
  it("shows the amber badge when the live transcript hash differs", async () => {
    vi.mocked(ipc.getTranscriptSha).mockResolvedValue("sha-LIVE-DIFFERENT");
    render(<NotesReceipt meetingId="m1" note={note()} />);
    expect(await screen.findByText("Transcript changed after these notes")).toBeInTheDocument();
  });

  it("stays quiet when the hashes match", async () => {
    vi.mocked(ipc.getTranscriptSha).mockResolvedValue("sha-gen");
    render(<NotesReceipt meetingId="m1" note={note()} />);
    await waitFor(() => expect(ipc.getTranscriptSha).toHaveBeenCalled());
    expect(screen.queryByText("Transcript changed after these notes")).not.toBeInTheDocument();
  });

  it("Re-enhance dispatches the same trigger as the command palette", async () => {
    vi.mocked(ipc.getTranscriptSha).mockResolvedValue("sha-LIVE-DIFFERENT");
    const heard = vi.fn();
    document.addEventListener("palette-enhance-notes", heard);
    try {
      render(<NotesReceipt meetingId="m1" note={note()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Re-enhance" }));
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("palette-enhance-notes", heard);
    }
  });
});

describe("previous version", () => {
  const withPrevious = () =>
    note({
      generated_previous: JSON.stringify({
        content: PREVIOUS_DOC,
        provider: "ollama",
        model: "llama3.2",
        generated_at: "2026-06-09T09:00:00Z",
        transcript_sha: "sha-old",
      }),
    });

  it("offers View previous only when the slot is filled", () => {
    const { rerender } = render(<NotesReceipt meetingId="m1" note={note()} />);
    expect(screen.queryByRole("button", { name: /View previous/ })).not.toBeInTheDocument();
    rerender(<NotesReceipt meetingId="m1" note={withPrevious()} />);
    expect(screen.getByRole("button", { name: /View previous/ })).toBeInTheDocument();
  });

  it("shows the previous version as read-only markdown", () => {
    render(<NotesReceipt meetingId="m1" note={withPrevious()} />);
    fireEvent.click(screen.getByRole("button", { name: /View previous/ }));
    expect(screen.getByText(/## Old Decisions/)).toBeInTheDocument();
    expect(screen.getByText(/the earlier take/)).toBeInTheDocument();
    // The envelope's own receipt rides along.
    expect(screen.getByText(/Ollama \(llama3\.2\)/)).toBeInTheDocument();
  });

  it("Restore calls the swap command with the note id", async () => {
    render(<NotesReceipt meetingId="m1" note={withPrevious()} />);
    fireEvent.click(screen.getByRole("button", { name: /View previous/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => {
      expect(ipc.restorePreviousNotes).toHaveBeenCalledWith("n1");
    });
  });

  it("a corrupt previous slot degrades to no affordance, not a crash", () => {
    render(
      <NotesReceipt meetingId="m1" note={note({ generated_previous: "not json{" })} />,
    );
    expect(screen.getByTestId("notes-receipt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View previous/ })).not.toBeInTheDocument();
  });
});

describe("receiptModelLabel", () => {
  it("maps anthropic model ids onto friendly names", () => {
    expect(receiptModelLabel("anthropic", "claude-sonnet-4-6")).toBe("Claude Sonnet");
    expect(receiptModelLabel("anthropic", "claude-opus-4-1")).toBe("Claude Opus");
    expect(receiptModelLabel("anthropic", "claude-haiku-4-5")).toBe("Claude Haiku");
    expect(receiptModelLabel("anthropic", "something-new")).toBe("Claude");
  });

  it("ollama shows the local model; apple is on-device", () => {
    expect(receiptModelLabel("ollama", "llama3.2")).toBe("Ollama (llama3.2)");
    expect(receiptModelLabel("apple", "on-device")).toBe("Apple Intelligence");
  });
});
