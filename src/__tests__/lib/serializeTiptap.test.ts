import { describe, expect, it } from "vitest";
import { serializeTiptapToMarkdown } from "../../lib/tiptap/serializeTiptap";
import { generatedNotesToTiptap } from "../../lib/tiptap/generatedNotesToTiptap";

describe("serializeTiptapToMarkdown", () => {
  it("keeps the AI summary and action items that the old extractor dropped", () => {
    const doc = generatedNotesToTiptap({
      title: "Sync",
      summary: "We agreed to ship Friday.",
      sections: [{ heading: "Decisions", bullets: ["Ship v2", "Skip the beta"] }],
      action_items: [
        { task: "Send recap", assignee: "Amy", deadline: "2026-06-12", source_start_ms: 65000 },
        { task: "Book room", assignee: null, deadline: null },
      ],
      tags: [],
    });
    const md = serializeTiptapToMarkdown(doc);

    expect(md).toContain("> **Summary:** We agreed to ship Friday.");
    expect(md).toContain("## Decisions");
    expect(md).toContain("- Ship v2");
    expect(md).toContain("- [ ] Send recap (@Amy, due ");
    expect(md).toContain("1:05)");
    expect(md).toContain("- [ ] Book room");
  });

  it("serializes standard nodes with marks and nesting", () => {
    const md = serializeTiptapToMarkdown({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "plain " },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "outer" }] },
                {
                  type: "bulletList",
                  content: [
                    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(md).toContain("# Title");
    expect(md).toContain("plain **bold**");
    expect(md).toContain("- outer");
    expect(md).toContain("  - inner");
  });

  it("degrades unknown nodes to their text instead of dropping them", () => {
    const md = serializeTiptapToMarkdown({
      type: "doc",
      content: [{ type: "mysteryNode", content: [{ type: "text", text: "survives" }] }],
    });
    expect(md).toBe("survives");
  });

  it("serializes link marks, composing with other marks (plan v8 B3)", () => {
    const md = serializeTiptapToMarkdown({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            {
              type: "text",
              text: "the docs",
              marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com/docs" } }],
            },
          ],
        },
      ],
    });
    expect(md).toBe("see [**the docs**](https://example.com/docs)");
  });

  it("drops unsafe-scheme links back to plain text (plan v8 B3)", () => {
    const md = serializeTiptapToMarkdown({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click me",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    });
    expect(md).toBe("click me");
  });

  it("renders mention atoms as @label, falling back to id (plan v8 B3)", () => {
    const md = serializeTiptapToMarkdown({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "ping " },
            { type: "mention", attrs: { id: "amy-1", label: "Amy" } },
            { type: "text", text: " and " },
            { type: "mention", attrs: { id: "sam", label: null } },
          ],
        },
      ],
    });
    expect(md).toBe("ping @Amy and @sam");
  });

  it("renders ⌘D timestamp chips from their attrs (atoms carry no text)", () => {
    const md = serializeTiptapToMarkdown({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "timestampChip", attrs: { ms: 754_000 } },
            { type: "text", text: " decision on pricing" },
          ],
        },
      ],
    });
    expect(md).toBe("⏱ 12:34 decision on pricing");
  });

  it("serializes pasted images as markdown links to the absolute path (plan v9 #13)", () => {
    const md = serializeTiptapToMarkdown({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "the slide:" }] },
        {
          type: "pastedImage",
          attrs: { src: "/Users/x/app-data/attachments/m1/pasted-1.png", alt: "pasted image" },
        },
      ],
    });
    expect(md).toBe(
      "the slide:\n\n![pasted image](</Users/x/app-data/attachments/m1/pasted-1.png>)",
    );
  });

  it("drops a pasted image with no path instead of emitting a broken link", () => {
    const md = serializeTiptapToMarkdown({
      type: "doc",
      content: [
        { type: "pastedImage", attrs: { src: "" } },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
    expect(md).toBe("after");
  });
});
