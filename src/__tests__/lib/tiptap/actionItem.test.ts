// src/__tests__/lib/tiptap/actionItem.test.ts
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ActionItem } from "../../../lib/tiptap/actionItem";

describe("ActionItem node", () => {
  it("round-trips all four attributes through JSON", () => {
    const editor = new Editor({
      extensions: [StarterKit, ActionItem],
      content: {
        type: "doc",
        content: [{
          type: "actionItem",
          attrs: {
            task: "Write the search spec",
            assignee: "Alice",
            deadline: "2026-08-05",
            done: false,
          },
        }],
      },
    });
    expect(editor.getJSON().content?.[0]).toEqual({
      type: "actionItem",
      attrs: { task: "Write the search spec", assignee: "Alice", deadline: "2026-08-05", done: false },
    });
    editor.destroy();
  });

  it("defaults assignee and deadline to null", () => {
    const editor = new Editor({
      extensions: [StarterKit, ActionItem],
      content: {
        type: "doc",
        content: [{ type: "actionItem", attrs: { task: "Solo task" } }],
      },
    });
    const node = editor.getJSON().content?.[0];
    expect(node?.attrs).toEqual({
      task: "Solo task",
      assignee: null,
      deadline: null,
      done: false,
    });
    editor.destroy();
  });
});
