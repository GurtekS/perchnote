import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FolderExplorer } from "../../components/folders/FolderExplorer";
import { FolderTree } from "../../components/folders/FolderTree";
import type { FolderNode } from "../../lib/ipc";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

function renderWithQuery(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makeFolder(overrides: Partial<FolderNode> = {}): FolderNode {
  return {
    id: "folder-1",
    name: "Projects",
    color: "#5a9c6a",
    icon: "folder",
    sort_order: 0,
    parent_id: null,
    meeting_count: 2,
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    children: [],
    ...overrides,
  };
}

describe("folder controls", () => {
  beforeEach(() => {
    resetTauriCoreMock();
    navigateMock.mockReset();
  });

  it("opens root folder cards from a named single-click button", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_folders: () => [makeFolder()],
      },
    });
    renderWithQuery(<FolderExplorer activeFolderId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Projects folder" }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/folders/$folderId",
      params: { folderId: "folder-1" },
    });
  });

  it("names folder tree actions and reports menu expansion state", () => {
    const folder = makeFolder();
    renderWithQuery(
      <FolderTree
        tree={[folder]}
        activeFolderId={null}
        onSelect={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Create subfolder in Projects" })).toBeInTheDocument();
    const menuButton = screen.getByRole("button", { name: "Projects folder actions" });
    expect(menuButton).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(menuButton);

    expect(menuButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });
});
