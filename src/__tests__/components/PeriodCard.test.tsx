import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodCard } from "../../components/insights/PeriodCard";
import { ipc } from "../../lib/ipc";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getPeriodNarrative: vi.fn(),
    generatePeriodNarrative: vi.fn(),
    exportBragDoc: vi.fn(),
    checkAiConfigured: vi.fn(),
  },
}));

const mocked = vi.mocked(ipc);

function render(ui: React.ReactElement) {
  return rtlRender(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PeriodCard", () => {
  it("renders a cached quarter narrative with the facts disclosure", async () => {
    mocked.getPeriodNarrative.mockResolvedValue({
      key: "narrative:2026-Q2",
      content: "You ramped from 8 meetings in April to 19 in June.\n\nDesign sync held steady.",
      facts: '{"period":"2026-Q2","meetings":41}',
      created_at: "2026-06-10T12:00:00Z",
    });
    mocked.checkAiConfigured.mockResolvedValue(true);
    render(<PeriodCard today="2026-06-10" />);

    await waitFor(() =>
      expect(
        screen.getByText("You ramped from 8 meetings in April to 19 in June."),
      ).toBeInTheDocument(),
    );
    expect(mocked.getPeriodNarrative).toHaveBeenCalledWith("2026-Q2");
    expect(screen.getByText("Design sync held steady.")).toBeInTheDocument();
    expect(screen.getByText("Regenerate")).toBeInTheDocument();
    expect(screen.getByText("What the AI saw")).toBeInTheDocument();
    expect(screen.getByText(/"meetings": 41/)).toBeInTheDocument();
  });

  it("switching the picker to This year requests the year period", async () => {
    mocked.getPeriodNarrative.mockResolvedValue(null);
    mocked.checkAiConfigured.mockResolvedValue(true);
    render(<PeriodCard today="2026-06-10" />);

    await waitFor(() => expect(mocked.getPeriodNarrative).toHaveBeenCalledWith("2026-Q2"));
    fireEvent.click(screen.getByText("This year"));
    await waitFor(() => expect(mocked.getPeriodNarrative).toHaveBeenCalledWith("2026"));
    expect(screen.getByText(/arc of your 2026/)).toBeInTheDocument();
  });

  it("gates narrative generation on AI but never the brag-doc export", async () => {
    mocked.getPeriodNarrative.mockResolvedValue(null);
    mocked.checkAiConfigured.mockResolvedValue(false);
    mocked.exportBragDoc.mockResolvedValue("/Users/x/Desktop/Perchnote brag doc 2026-Q2.md");
    render(<PeriodCard today="2026-06-10" />);

    await waitFor(() =>
      expect(screen.getByText("Set up a provider")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Write it")).not.toBeInTheDocument();

    // Deterministic export still works without a provider.
    fireEvent.click(screen.getByText("Export brag doc"));
    await waitFor(() => expect(mocked.exportBragDoc).toHaveBeenCalledWith("2026-Q2"));
  });

  it("offers generation when AI is configured and nothing is cached", async () => {
    mocked.getPeriodNarrative.mockResolvedValue(null);
    mocked.checkAiConfigured.mockResolvedValue(true);
    render(<PeriodCard today="2026-06-10" />);

    await waitFor(() => expect(screen.getByText("Write it")).toBeInTheDocument());
    expect(screen.getByText(/never sent/)).toBeInTheDocument();
    expect(screen.getByText("Export brag doc")).toBeInTheDocument();
  });
});
