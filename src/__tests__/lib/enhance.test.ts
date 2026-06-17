import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEnhance, extractPlainText } from "../../lib/enhance";
import { ipc } from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({
  ipc: {
    getOrCreateNote: vi.fn(),
    generateMeetingNotes: vi.fn(),
    updateNoteContents: vi.fn().mockResolvedValue(undefined),
    updateNoteContentsWithReceipt: vi.fn().mockResolvedValue(undefined),
    // Mirror chain (plan v8 B1). getMeeting defaults to undefined →
    // the best-effort mirror quietly skips in tests that don't stub it.
    getMeeting: vi.fn(),
    getMeetingTags: vi.fn(),
    getMeetingFolders: vi.fn(),
    getRecordingPath: vi.fn(),
    writeMdMirror: vi.fn(),
  },
}));

const GENERATED = {
  title: "Sync",
  summary: "We agreed to ship Friday.",
  sections: [{ heading: "Decisions", bullets: ["Ship v2"] }],
  action_items: [{ task: "Send recap", assignee: "Amy", deadline: null }],
  tags: [],
};

describe("runEnhance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.getOrCreateNote).mockResolvedValue({
      id: "n1",
      raw_content: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"my jottings"}]}]}',
    } as never);
    vi.mocked(ipc.generateMeetingNotes).mockResolvedValue(GENERATED as never);
    vi.mocked(ipc.updateNoteContents).mockResolvedValue(undefined as never);
    vi.mocked(ipc.updateNoteContentsWithReceipt).mockResolvedValue(undefined as never);
  });

  it("reads stored raw notes when no live content is passed (instant recap path)", async () => {
    const qc = new QueryClient();
    const result = await runEnhance(qc, "m1");

    // The user's jottings reached the AI as plain text…
    expect(vi.mocked(ipc.generateMeetingNotes).mock.calls[0]).toEqual(["m1", "my jottings", null]);
    // …and were preserved as raw_content in the same atomic write as the AI doc.
    const [noteId, raw, generatedJson] = vi.mocked(ipc.updateNoteContents).mock.calls[0];
    expect(noteId).toBe("n1");
    expect(raw).toContain("my jottings");
    expect(JSON.parse(generatedJson as string).type).toBe("doc");
    expect(result.generated.action_items).toHaveLength(1);
    expect(result.rawMarkdown).toContain("## Decisions");
  });

  it("persists through the receipt writer when the backend stamped one (plan v10 #2)", async () => {
    vi.mocked(ipc.generateMeetingNotes).mockResolvedValue({
      ...GENERATED,
      receipt: { provider: "anthropic", model: "claude-sonnet-4-6", transcript_sha: "sha-1" },
    } as never);

    const qc = new QueryClient();
    await runEnhance(qc, "m1");

    expect(ipc.updateNoteContents).not.toHaveBeenCalled();
    const [noteId, raw, generatedJson, provider, model, sha] =
      vi.mocked(ipc.updateNoteContentsWithReceipt).mock.calls[0];
    expect(noteId).toBe("n1");
    expect(raw).toContain("my jottings");
    expect(JSON.parse(generatedJson as string).type).toBe("doc");
    expect(provider).toBe("anthropic");
    expect(model).toBe("claude-sonnet-4-6");
    expect(sha).toBe("sha-1");
  });

  it("falls back to the plain writer when no receipt was stamped", async () => {
    const qc = new QueryClient();
    await runEnhance(qc, "m1");
    expect(ipc.updateNoteContents).toHaveBeenCalledTimes(1);
    expect(ipc.updateNoteContentsWithReceipt).not.toHaveBeenCalled();
  });

  it("prefers live editor content over the stored note (button path)", async () => {
    const qc = new QueryClient();
    const live = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"unsaved typing"}]}]}';
    await runEnhance(qc, "m1", { currentContent: live, templateId: "tpl-1" });

    expect(vi.mocked(ipc.generateMeetingNotes).mock.calls[0]).toEqual(["m1", "unsaved typing", "tpl-1"]);
    expect(vi.mocked(ipc.updateNoteContents).mock.calls[0][1]).toBe(live);
  });

  it("mirrors through the canonical writer — frontmatter, not a bare body (plan v8 B1)", async () => {
    vi.mocked(ipc.getMeeting).mockResolvedValue({
      id: "m1",
      title: "Sync",
      scheduled_start: null,
      scheduled_end: null,
      actual_start: "2026-06-09T14:00:00",
      actual_end: "2026-06-09T14:45:00",
      location: null,
      platform: "unknown",
      created_at: "2026-06-09T13:55:00",
    } as never);
    vi.mocked(ipc.getMeetingTags).mockResolvedValue([
      { id: "t1", name: "roadmap", source: "user", created_at: "" },
    ] as never);
    vi.mocked(ipc.getMeetingFolders).mockResolvedValue([{ name: "Work" }] as never);
    vi.mocked(ipc.getRecordingPath).mockResolvedValue("/rec/m1.wav" as never);
    vi.mocked(ipc.writeMdMirror).mockResolvedValue("" as never);

    const qc = new QueryClient();
    await runEnhance(qc, "m1");

    expect(ipc.writeMdMirror).toHaveBeenCalledTimes(1);
    const [meetingId, content] = vi.mocked(ipc.writeMdMirror).mock.calls[0] as [string, string];
    expect(meetingId).toBe("m1");
    expect(content.startsWith('---\ntitle: "Sync"\n')).toBe(true);
    expect(content).toContain("duration_minutes: 45");
    expect(content).toContain("tags: [perchnote, roadmap]");
    expect(content).toContain("folders: [Work]");
    expect(content).toContain('audio: "/rec/m1.wav"');
    expect(content).toContain("\n# Sync\n");
    expect(content).toContain("## Decisions");
  });
});

describe("extractPlainText", () => {
  it("flattens headings, paragraphs, and list items", () => {
    const text = extractPlainText({
      type: "doc",
      content: [
        { type: "heading", content: [{ text: "Agenda" }] },
        { type: "paragraph", content: [{ text: "hello" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ text: "first" }] }] },
          ],
        },
      ],
    });
    expect(text).toBe("Agenda\nhello\n- first");
  });

  it("keeps task lists — including carry-forward checklists — visible to the AI", () => {
    const text = extractPlainText({
      type: "doc",
      content: [
        { type: "heading", content: [{ text: "From last time (Design sync)" }] },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ text: "ship the deck" }] }],
            },
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ text: "book the room" }] }],
            },
          ],
        },
      ],
    });
    expect(text).toBe(
      "From last time (Design sync)\n- [ ] ship the deck\n- [x] book the room",
    );
  });

  it("serializes action items from their attrs (atomic nodes carry no text)", () => {
    const text = extractPlainText({
      type: "doc",
      content: [
        {
          type: "actionItem",
          attrs: { task: "send pricing", assignee: "Amy", deadline: "2026-06-12", done: false },
        },
      ],
    });
    expect(text).toBe("- [ ] send pricing (Amy) due 2026-06-12");
  });

  it("prefixes blocks stamped while recording with their [m:ss] anchor", () => {
    const text = extractPlainText({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { t_ms: 754_000 }, content: [{ text: "pricing concern Q3" }] },
        { type: "paragraph", content: [{ text: "typed before the recording" }] },
      ],
    });
    expect(text).toBe("[12:34] pricing concern Q3\ntyped before the recording");
  });

  it("surfaces ⌘D chips to the AI as [m:ss] anchors", () => {
    const text = extractPlainText({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "timestampChip", attrs: { ms: 62_000 } },
            { type: "text", text: " budget pushback here" },
          ],
        },
      ],
    });
    expect(text).toBe("[1:02] budget pushback here");
  });

  it("walks quotes, callouts, toggles, and code blocks", () => {
    const text = extractPlainText({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ text: "verbatim line" }] }],
        },
        {
          type: "callout",
          attrs: { variant: "warn" },
          content: [{ type: "paragraph", content: [{ text: "watch the budget" }] }],
        },
        {
          type: "toggle",
          attrs: { summary: "Details" },
          content: [{ type: "paragraph", content: [{ text: "hidden specifics" }] }],
        },
        { type: "codeBlock", content: [{ text: "SELECT 1;" }] },
      ],
    });
    expect(text).toBe(
      "> verbatim line\nwatch the budget\nDetails\nhidden specifics\nSELECT 1;",
    );
  });

  it("skips pasted images silently — no text, no disk path, no crash (plan v9 #13)", () => {
    const text = extractPlainText({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ text: "before the slide" }] },
        {
          type: "pastedImage",
          attrs: { src: "/Users/x/app-data/attachments/m1/pasted-1.png", alt: "pasted image" },
        },
        { type: "paragraph", content: [{ text: "after the slide" }] },
      ],
    });
    expect(text).toBe("before the slide\nafter the slide");
    expect(text).not.toContain("pasted-1.png");
  });
});
