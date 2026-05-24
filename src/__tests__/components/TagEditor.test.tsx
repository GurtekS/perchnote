import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { TagEditor } from "../../components/meeting/TagEditor";
import type { Tag } from "../../lib/ipc";
import { resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

function renderTagEditor(meetingId = "meeting-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TagEditor meetingId={meetingId} />
    </QueryClientProvider>,
  );
}

function makeTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: "tag-1",
    name: "Priority",
    source: "manual",
    created_at: "2026-05-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("TagEditor", () => {
  beforeEach(() => {
    resetTauriCoreMock();
  });

  it("gives each tag removal control a descriptive accessible name", async () => {
    const tag = makeTag();
    let removedTagId: string | null = null;
    resetTauriCoreMock({
      commandHandlers: {
        get_meeting_tags: () => [tag],
        list_tags: () => [tag],
        remove_tag_from_meeting: (args) => {
          removedTagId = String(args?.tagId);
          return null;
        },
      },
    });

    renderTagEditor();

    const removeButton = await screen.findByRole("button", { name: "Remove Priority tag" });
    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(removedTagId).toBe("tag-1");
    });
  });
});
