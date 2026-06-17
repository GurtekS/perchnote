import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIRROR_SAVE_DEBOUNCE_MS,
  cancelAllMirrors,
  cancelMirror,
  mirrorMeeting,
  scheduleMirror,
} from "../../lib/mirrorLifecycle";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";

vi.mock("../../lib/ipc", () => ({
  ipc: {
    getSetting: vi.fn(),
    getMeeting: vi.fn(),
    getNoteByMeeting: vi.fn(),
    getMeetingTags: vi.fn(),
    getMeetingFolders: vi.fn(),
    getRecordingPath: vi.fn(),
    writeMdMirror: vi.fn(),
    revealInFinder: vi.fn(),
  },
}));

// The conflict surface (plan v10 #9) is a toast — capture instead of render.
vi.mock("../../stores/toastStore", () => ({
  toast: { action: vi.fn() },
}));

const CLEAN = { path: "/v/2026-06-09 Sync.md", conflicted: false };
const CONFLICTED = { path: "/v/2026-06-09 Sync.conflict.md", conflicted: true };

const meeting = (id: string) =>
  ({
    id,
    title: "Sync",
    scheduled_start: null,
    scheduled_end: null,
    actual_start: "2026-06-09T14:00:00",
    actual_end: "2026-06-09T14:45:00",
    location: null,
    platform: "unknown",
    created_at: "2026-06-09T13:55:00",
  }) as never;

const tiptap = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

/** Drain the resolved-promise chain the fired timer kicked off. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("mirror lifecycle (plan v8 B2)", () => {
  beforeEach(async () => {
    // Pre-warm mirrorMeeting's dynamic imports so they resolve as microtasks
    // under fake timers instead of real module-load tasks.
    await Promise.all([
      import("../../lib/tiptap/serializeTiptap"),
      import("../../lib/mirrorMarkdown"),
    ]);
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(ipc.getSetting).mockResolvedValue("true");
    vi.mocked(ipc.getMeetingTags).mockResolvedValue([]);
    vi.mocked(ipc.getMeetingFolders).mockResolvedValue([]);
    vi.mocked(ipc.getRecordingPath).mockResolvedValue(null);
    vi.mocked(ipc.writeMdMirror).mockResolvedValue(CLEAN);
    vi.mocked(ipc.getNoteByMeeting).mockResolvedValue({
      id: "n1",
      raw_content: tiptap("raw jottings"),
      generated_content: tiptap("ai notes body"),
    } as never);
  });

  afterEach(() => {
    cancelAllMirrors(); // reset module-level queue between tests
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("writes once after a burst of saves (trailing debounce)", async () => {
    vi.mocked(ipc.getMeeting).mockResolvedValue(meeting("m-burst"));

    scheduleMirror("m-burst");
    await vi.advanceTimersByTimeAsync(1_000);
    scheduleMirror("m-burst");
    await vi.advanceTimersByTimeAsync(1_000);
    scheduleMirror("m-burst");
    expect(ipc.writeMdMirror).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();
    expect(ipc.writeMdMirror).toHaveBeenCalledTimes(1);
    const [id, content] = vi.mocked(ipc.writeMdMirror).mock.calls[0] as [string, string];
    expect(id).toBe("m-burst");
    expect(content).toContain("\n# Sync\n");
  });

  it("restarts the window on every save — fires only after edits settle", async () => {
    vi.mocked(ipc.getMeeting).mockResolvedValue(meeting("m-restart"));

    scheduleMirror("m-restart");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS - 1_000);
    scheduleMirror("m-restart"); // re-arms the full window
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS - 1_000);
    await flush();
    expect(ipc.writeMdMirror).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(ipc.writeMdMirror).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the mirror is disabled", async () => {
    vi.mocked(ipc.getSetting).mockResolvedValue("false");
    vi.mocked(ipc.getMeeting).mockResolvedValue(meeting("m-off"));

    scheduleMirror("m-off");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();

    expect(ipc.writeMdMirror).not.toHaveBeenCalled();
    // Bails before fetching anything — one settings read per flush, no more.
    expect(ipc.getMeeting).not.toHaveBeenCalled();
  });

  it("mirrors the AI doc when present, like Sync all", async () => {
    vi.mocked(ipc.getMeeting).mockResolvedValue(meeting("m-ai"));

    scheduleMirror("m-ai");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();

    const [, content] = vi.mocked(ipc.writeMdMirror).mock.calls[0] as [string, string];
    expect(content).toContain("ai notes body");
    expect(content).not.toContain("raw jottings");
  });

  it("falls back to raw notes, and skips meetings with nothing to mirror", async () => {
    vi.mocked(ipc.getMeeting).mockResolvedValue(meeting("m-raw"));
    vi.mocked(ipc.getNoteByMeeting).mockResolvedValue({
      id: "n1",
      raw_content: tiptap("raw jottings"),
      generated_content: null,
    } as never);

    scheduleMirror("m-raw");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();
    expect(vi.mocked(ipc.writeMdMirror).mock.calls[0][1]).toContain("raw jottings");

    vi.mocked(ipc.getNoteByMeeting).mockResolvedValue(null);
    scheduleMirror("m-raw");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();
    expect(ipc.writeMdMirror).toHaveBeenCalledTimes(1); // no second write
  });

  it("debounces each meeting independently", async () => {
    vi.mocked(ipc.getMeeting).mockImplementation((id: string) =>
      Promise.resolve(meeting(id)),
    );

    scheduleMirror("m-one");
    scheduleMirror("m-two");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();

    const ids = vi.mocked(ipc.writeMdMirror).mock.calls.map((c) => c[0]);
    expect(ids.sort()).toEqual(["m-one", "m-two"]);
  });

  it("never lets a mirror failure escape the save path", async () => {
    vi.mocked(ipc.getMeeting).mockRejectedValue(new Error("backend down"));

    scheduleMirror("m-fail");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush(); // would surface as an unhandled rejection if it threw
    expect(ipc.writeMdMirror).not.toHaveBeenCalled();
  });

  it("cancelMirror drops the queued write — nothing fires after a hard delete (audit P3-C)", async () => {
    vi.mocked(ipc.getMeeting).mockResolvedValue(meeting("m-purged"));

    scheduleMirror("m-purged");
    cancelMirror("m-purged");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();

    // Never even woke up: no settings read, no write.
    expect(ipc.getSetting).not.toHaveBeenCalled();
    expect(ipc.writeMdMirror).not.toHaveBeenCalled();
  });

  it("cancelMirror is per-meeting, tolerates unknown ids, and doesn't poison re-arming", async () => {
    vi.mocked(ipc.getMeeting).mockImplementation((id: string) =>
      Promise.resolve(meeting(id)),
    );

    scheduleMirror("m-keep");
    scheduleMirror("m-purged");
    cancelMirror("m-purged");
    cancelMirror("m-never-scheduled"); // no-op
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();
    expect(vi.mocked(ipc.writeMdMirror).mock.calls.map((c) => c[0])).toEqual(["m-keep"]);

    // A later save schedules the cancelled id again like any other meeting.
    scheduleMirror("m-purged");
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();
    expect(vi.mocked(ipc.writeMdMirror).mock.calls.map((c) => c[0])).toEqual([
      "m-keep",
      "m-purged",
    ]);
  });

  it("cancelAllMirrors flushes the whole queue — the empty-trash path", async () => {
    vi.mocked(ipc.getMeeting).mockImplementation((id: string) =>
      Promise.resolve(meeting(id)),
    );

    scheduleMirror("m-one");
    scheduleMirror("m-two");
    cancelAllMirrors();
    await vi.advanceTimersByTimeAsync(MIRROR_SAVE_DEBOUNCE_MS);
    await flush();

    expect(ipc.getSetting).not.toHaveBeenCalled();
    expect(ipc.writeMdMirror).not.toHaveBeenCalled();
  });
});

describe("mirrorMeeting with an explicit doc (post-enhance path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.getMeeting).mockResolvedValue(meeting("m-doc"));
    vi.mocked(ipc.getMeetingTags).mockResolvedValue([
      { id: "t1", name: "roadmap", source: "user", created_at: "" },
    ] as never);
    vi.mocked(ipc.getMeetingFolders).mockResolvedValue([{ name: "Work" }] as never);
    vi.mocked(ipc.getRecordingPath).mockResolvedValue(null);
    vi.mocked(ipc.writeMdMirror).mockResolvedValue(CLEAN);
  });

  it("links the local recording in frontmatter when one exists (B7)", async () => {
    vi.mocked(ipc.getRecordingPath).mockResolvedValue("/Users/x/rec/m-doc.wav");

    await mirrorMeeting("m-doc", JSON.parse(tiptap("body")));

    const [, content] = vi.mocked(ipc.writeMdMirror).mock.calls[0] as [string, string];
    expect(content).toContain('audio: "/Users/x/rec/m-doc.wav"');
  });

  it("omits the audio key when the lookup fails — never costs the mirror", async () => {
    vi.mocked(ipc.getRecordingPath).mockRejectedValue(new Error("no recording"));

    await mirrorMeeting("m-doc", JSON.parse(tiptap("body")));

    const [, content] = vi.mocked(ipc.writeMdMirror).mock.calls[0] as [string, string];
    expect(content).not.toContain("audio:");
  });

  it("serializes the passed doc instead of reading the stored note", async () => {
    await mirrorMeeting("m-doc", JSON.parse(tiptap("freshly generated")));

    expect(ipc.getNoteByMeeting).not.toHaveBeenCalled();
    const [id, content] = vi.mocked(ipc.writeMdMirror).mock.calls[0] as [string, string];
    expect(id).toBe("m-doc");
    expect(content.startsWith('---\ntitle: "Sync"\n')).toBe(true);
    expect(content).toContain("tags: [perchnote, roadmap]");
    expect(content).toContain("folders: [Work]");
    expect(content).toContain("freshly generated");
  });
});

describe("clobber-guard conflicts surface as a toast (plan v10 #9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.getMeeting).mockImplementation((id: string) =>
      Promise.resolve(meeting(id)),
    );
    vi.mocked(ipc.getMeetingTags).mockResolvedValue([]);
    vi.mocked(ipc.getMeetingFolders).mockResolvedValue([]);
    vi.mocked(ipc.getRecordingPath).mockResolvedValue(null);
    vi.mocked(ipc.revealInFinder).mockResolvedValue(undefined);
  });

  it("toasts once per conflict event, not on every debounced re-write", async () => {
    vi.mocked(ipc.writeMdMirror).mockResolvedValue(CONFLICTED);

    // The same unresolved external edit re-conflicts on every flush…
    await mirrorMeeting("m-cfl-once", JSON.parse(tiptap("body")));
    await mirrorMeeting("m-cfl-once", JSON.parse(tiptap("body v2")));
    expect(ipc.writeMdMirror).toHaveBeenCalledTimes(2);

    // …but the user is told exactly once, naming the conflict file, with a
    // Show-in-Finder action pointed at the folder (not the file — the
    // reveal command opens directories).
    expect(toast.action).toHaveBeenCalledTimes(1);
    const [message, label, onClick] = vi.mocked(toast.action).mock.calls[0] as [
      string,
      string,
      () => void,
    ];
    expect(message).toContain("2026-06-09 Sync.conflict.md");
    expect(label).toBe("Show in Finder");
    onClick();
    expect(ipc.revealInFinder).toHaveBeenCalledWith("/v");
  });

  it("a clean write clears the latch — the next distinct conflict toasts again", async () => {
    vi.mocked(ipc.writeMdMirror).mockResolvedValue(CONFLICTED);
    await mirrorMeeting("m-cfl-relatch", JSON.parse(tiptap("body")));
    expect(toast.action).toHaveBeenCalledTimes(1);

    // The user resolves it (e.g. deletes the stale file) → clean write.
    vi.mocked(ipc.writeMdMirror).mockResolvedValue(CLEAN);
    await mirrorMeeting("m-cfl-relatch", JSON.parse(tiptap("body")));
    expect(toast.action).toHaveBeenCalledTimes(1);

    // A NEW external edit later deserves its own heads-up.
    vi.mocked(ipc.writeMdMirror).mockResolvedValue(CONFLICTED);
    await mirrorMeeting("m-cfl-relatch", JSON.parse(tiptap("body")));
    expect(toast.action).toHaveBeenCalledTimes(2);
  });

  it("latches per meeting — one meeting's conflict never mutes another's", async () => {
    vi.mocked(ipc.writeMdMirror).mockResolvedValue(CONFLICTED);
    await mirrorMeeting("m-cfl-a", JSON.parse(tiptap("body")));
    await mirrorMeeting("m-cfl-b", JSON.parse(tiptap("body")));
    expect(toast.action).toHaveBeenCalledTimes(2);
  });

  it("never toasts on clean writes", async () => {
    vi.mocked(ipc.writeMdMirror).mockResolvedValue(CLEAN);
    await mirrorMeeting("m-cfl-clean", JSON.parse(tiptap("body")));
    expect(toast.action).not.toHaveBeenCalled();
  });
});
