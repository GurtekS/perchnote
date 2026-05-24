import { describe, it, expect } from "vitest";
import { generatedNotesToTiptap, GeneratedNotes } from "../../../lib/tiptap/generatedNotesToTiptap";

describe("generatedNotesToTiptap", () => {
  const fullNotes: GeneratedNotes = {
    title: "Q3 Planning",
    summary: "Agreed to ship search by end of August.",
    sections: [
      { heading: "Decisions", bullets: ["Ship search", "Defer mobile"] },
      { heading: "Key points", bullets: ["Index pipeline is the blocker"] },
    ],
    action_items: [
      { task: "Write the spec", assignee: "Alice", deadline: "2026-08-05" },
      { task: "Schedule review", assignee: null, deadline: null },
    ],
    tags: ["planning", "q3"],
  };

  it("builds a doc with the tags attribute on the root", () => {
    const doc = generatedNotesToTiptap(fullNotes);
    expect(doc.type).toBe("doc");
    expect(doc.attrs?.tags).toEqual(["planning", "q3"]);
  });

  it("places the summary node first in doc content", () => {
    const doc = generatedNotesToTiptap(fullNotes);
    expect(doc.content[0]).toMatchObject({
      type: "summary",
      content: [{ type: "text", text: "Agreed to ship search by end of August." }],
    });
  });

  it("emits each section as h2 + bullet list", () => {
    const doc = generatedNotesToTiptap(fullNotes);
    const decisionsHeading = doc.content[1];
    expect(decisionsHeading).toMatchObject({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Decisions" }],
    });
    const decisionsList = doc.content[2] as { type: string; content: unknown[] };
    expect(decisionsList.type).toBe("bulletList");
    expect(decisionsList.content).toHaveLength(2);
  });

  it("emits an Action Items heading then one actionItem per entry", () => {
    const doc = generatedNotesToTiptap(fullNotes);
    const headings = doc.content.filter((n) => (n as { type: string }).type === "heading");
    expect(headings.some((h) => (h as { content?: unknown[] }).content?.[0] && (h as { content: { text: string }[] }).content[0].text === "Action Items")).toBe(true);

    const actionItems = doc.content.filter((n) => (n as { type: string }).type === "actionItem");
    expect(actionItems).toHaveLength(2);
    expect((actionItems[0] as { attrs: object }).attrs).toEqual({
      task: "Write the spec", assignee: "Alice", deadline: "2026-08-05", done: false,
    });
    expect((actionItems[1] as { attrs: object }).attrs).toEqual({
      task: "Schedule review", assignee: null, deadline: null, done: false,
    });
  });

  it("omits the summary node when summary is empty", () => {
    const doc = generatedNotesToTiptap({ ...fullNotes, summary: "" });
    expect(doc.content[0]).not.toMatchObject({ type: "summary" });
  });

  it("omits the Action Items section when action_items is empty", () => {
    const doc = generatedNotesToTiptap({ ...fullNotes, action_items: [] });
    const headings = doc.content.filter((n) => (n as { type: string }).type === "heading") as { content: { text: string }[] }[];
    expect(headings.some((h) => h.content[0]?.text === "Action Items")).toBe(false);
  });
});
