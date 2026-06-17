import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataSettings } from "../../components/settings/DataSettings";
import type { Meeting } from "../../lib/ipc";
import { useToastStore } from "../../stores/toastStore";

const { ipcMock, cancelAllMirrorsMock } = vi.hoisted(() => ({
  cancelAllMirrorsMock: vi.fn(),
  ipcMock: {
    getStorageStats: vi.fn(),
    getStorageBreakdown: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    previewAudioRetention: vi.fn(),
    getAppPaths: vi.fn(),
    listDeletedMeetings: vi.fn(),
    listArchivedMeetings: vi.fn(),
    listBackupArchives: vi.fn(),
    emptyTrash: vi.fn(),
    restoreMeeting: vi.fn(),
    // Sync-all chain (plan v8 B4 / v10 #9).
    listMeetings: vi.fn(),
    getTagsForMeetings: vi.fn(),
    getFolderMembershipsMap: vi.fn(),
    listFolders: vi.fn(),
    getNoteByMeeting: vi.fn(),
    getRecordingPath: vi.fn(),
    writeMdMirror: vi.fn(),
  },
}));

vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));
// The wiring under test (audit P3-C): a hard delete must drop every queued
// debounced mirror before the backend purge starts.
vi.mock("../../lib/mirrorLifecycle", () => ({ cancelAllMirrors: cancelAllMirrorsMock }));

const TRASHED: Meeting = {
  id: "m-trashed",
  title: "Old sync",
  scheduled_start: null,
  scheduled_end: null,
  actual_start: null,
  actual_end: null,
  calendar_event_id: null,
  attendees: "[]",
  location: null,
  meeting_url: null,
  platform: "manual",
  status: "complete",
  is_pinned: false,
  is_archived: false,
  deleted_at: "2026-06-01T00:00:00Z",
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  device_name: null,
  system_audio_captured: false,
  note_status: "none",
};

describe("DataSettings empty trash (audit P3-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMock.getStorageStats.mockResolvedValue({
      total_meetings: 1,
      total_transcripts: 0,
      total_notes: 0,
      total_chat_messages: 0,
      db_size_bytes: 0,
    });
    ipcMock.getStorageBreakdown.mockResolvedValue(null);
    ipcMock.getSetting.mockResolvedValue(null);
    ipcMock.setSetting.mockResolvedValue(undefined);
    ipcMock.getAppPaths.mockResolvedValue(null);
    ipcMock.listDeletedMeetings.mockResolvedValue([TRASHED]);
    ipcMock.listArchivedMeetings.mockResolvedValue([]);
    ipcMock.listBackupArchives.mockResolvedValue([]);
    ipcMock.emptyTrash.mockResolvedValue(1);
  });

  it("cancels every queued mirror before the backend purge starts", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DataSettings />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Empty trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));

    await waitFor(() => expect(ipcMock.emptyTrash).toHaveBeenCalledTimes(1));
    expect(cancelAllMirrorsMock).toHaveBeenCalledTimes(1);
    // Ordering matters: the queue must be flushed before the hard delete —
    // a 5s timer firing mid-purge would orphan a vault file.
    expect(cancelAllMirrorsMock.mock.invocationCallOrder[0]).toBeLessThan(
      ipcMock.emptyTrash.mock.invocationCallOrder[0],
    );
  });
});

describe("DataSettings sync-all reports clobber-guard conflicts (plan v10 #9)", () => {
  const note = {
    id: "n1",
    raw_content: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "notes" }] }],
    }),
    generated_content: null,
  };
  const meetingFor = (id: string): Meeting => ({ ...TRASHED, id, deleted_at: null });

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMock.getStorageStats.mockResolvedValue({
      total_meetings: 3,
      total_transcripts: 0,
      total_notes: 0,
      total_chat_messages: 0,
      db_size_bytes: 0,
    });
    ipcMock.getStorageBreakdown.mockResolvedValue(null);
    // The mirror section (and its Sync all button) only renders when on.
    ipcMock.getSetting.mockImplementation((key: string) =>
      Promise.resolve(key === "md_mirror_enabled" ? "true" : null),
    );
    ipcMock.setSetting.mockResolvedValue(undefined);
    ipcMock.getAppPaths.mockResolvedValue(null);
    ipcMock.listDeletedMeetings.mockResolvedValue([]);
    ipcMock.listArchivedMeetings.mockResolvedValue([]);
    ipcMock.listBackupArchives.mockResolvedValue([]);
    ipcMock.listMeetings.mockResolvedValue([meetingFor("m1"), meetingFor("m2"), meetingFor("m3")]);
    ipcMock.getTagsForMeetings.mockResolvedValue({});
    ipcMock.getFolderMembershipsMap.mockResolvedValue({});
    ipcMock.listFolders.mockResolvedValue([]);
    ipcMock.getNoteByMeeting.mockResolvedValue(note);
    ipcMock.getRecordingPath.mockResolvedValue(null);
  });

  const syncAll = async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DataSettings />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sync all notes now" }));
    await waitFor(() => expect(ipcMock.writeMdMirror).toHaveBeenCalledTimes(3));
  };

  it("counts conflicted writes and reports them once, beside the success toast", async () => {
    ipcMock.writeMdMirror
      .mockResolvedValueOnce({ path: "/v/2026-06-01 A.md", conflicted: false })
      .mockResolvedValueOnce({ path: "/v/2026-06-02 B.conflict.md", conflicted: true })
      .mockResolvedValueOnce({ path: "/v/2026-06-03 C.conflict.md", conflicted: true });

    await syncAll();

    await waitFor(() => {
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      // Conflicted files still count as mirrored — their content was written,
      // just to a .conflict.md the user gets told about.
      expect(messages).toContain("Mirrored 3 meetings to Documents/Perchnote");
      expect(messages).toContain("2 files had your edits. Wrote .conflict.md beside them");
    });
  });

  it("uses singular copy for one conflict and stays quiet with none", async () => {
    ipcMock.writeMdMirror
      .mockResolvedValueOnce({ path: "/v/a.md", conflicted: false })
      .mockResolvedValueOnce({ path: "/v/b.conflict.md", conflicted: true })
      .mockResolvedValueOnce({ path: "/v/c.md", conflicted: false });

    await syncAll();

    await waitFor(() => {
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        "1 file had your edits. Wrote .conflict.md beside it",
      );
    });

    // A fully clean sweep mentions no conflicts at all.
    useToastStore.setState({ toasts: [] });
    ipcMock.writeMdMirror.mockResolvedValue({ path: "/v/x.md", conflicted: false });
    fireEvent.click(screen.getByRole("button", { name: "Sync all notes now" }));
    await waitFor(() => expect(ipcMock.writeMdMirror).toHaveBeenCalledTimes(6));
    await waitFor(() => {
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      expect(messages).toContain("Mirrored 3 meetings to Documents/Perchnote");
      expect(messages.some((m) => m.includes(".conflict.md"))).toBe(false);
    });
  });
});
