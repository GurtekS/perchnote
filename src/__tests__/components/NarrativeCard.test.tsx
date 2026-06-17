import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NarrativeCard } from "../../components/insights/NarrativeCard";
import { ipc } from "../../lib/ipc";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getMonthlyNarrative: vi.fn(),
    generateMonthlyNarrative: vi.fn(),
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

describe("NarrativeCard", () => {
  it("renders a cached narrative with the facts disclosure", async () => {
    mocked.getMonthlyNarrative.mockResolvedValue({
      key: "narrative:2026-06",
      content: "You met 14 times in June.\n\nDesign sync anchored the month.",
      facts: '{"meetings":14}',
      created_at: "2026-06-30T12:00:00Z",
    });
    mocked.checkAiConfigured.mockResolvedValue(true);
    render(<NarrativeCard month="2026-06" />);

    await waitFor(() =>
      expect(screen.getByText("You met 14 times in June.")).toBeInTheDocument(),
    );
    expect(screen.getByText("Design sync anchored the month.")).toBeInTheDocument();
    expect(screen.getByText("Regenerate")).toBeInTheDocument();
    expect(screen.getByText("What the AI saw")).toBeInTheDocument();
    expect(screen.getByText(/"meetings": 14/)).toBeInTheDocument();
  });

  it("offers generation when AI is configured and nothing is cached", async () => {
    mocked.getMonthlyNarrative.mockResolvedValue(null);
    mocked.checkAiConfigured.mockResolvedValue(true);
    render(<NarrativeCard month="2026-06" />);

    await waitFor(() => expect(screen.getByText("Write it")).toBeInTheDocument());
    expect(screen.getByText(/never sent/)).toBeInTheDocument();
  });

  it("points at provider setup when AI is not configured", async () => {
    mocked.getMonthlyNarrative.mockResolvedValue(null);
    mocked.checkAiConfigured.mockResolvedValue(false);
    render(<NarrativeCard month="2026-06" />);

    await waitFor(() =>
      expect(screen.getByText("Set up a provider")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Write it")).not.toBeInTheDocument();
  });

  it("titles itself with the month name", async () => {
    mocked.getMonthlyNarrative.mockResolvedValue(null);
    mocked.checkAiConfigured.mockResolvedValue(false);
    render(<NarrativeCard month="2026-06" />);
    expect(screen.getByText("Your June")).toBeInTheDocument();
  });
});
