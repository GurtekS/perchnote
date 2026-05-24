import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Toggle } from "../../../lib/tiptap/toggle";

describe("Toggle node", () => {
  it("round-trips summary and open attributes", () => {
    const editor = new Editor({
      extensions: [StarterKit, Toggle],
      content: {
        type: "doc",
        content: [{
          type: "toggle",
          attrs: { summary: "Click to expand", open: true },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Hidden details" }] }],
        }],
      },
    });
    expect((editor.getJSON().content?.[0] as { attrs: { summary: string; open: boolean } }).attrs).toEqual({
      summary: "Click to expand",
      open: true,
    });
    editor.destroy();
  });

  it("defaults summary to empty and open to true (visible by default)", () => {
    const editor = new Editor({
      extensions: [StarterKit, Toggle],
      content: {
        type: "doc",
        content: [{ type: "toggle", content: [{ type: "paragraph" }] }],
      },
    });
    const attrs = (editor.getJSON().content?.[0] as { attrs: { summary: string; open: boolean } }).attrs;
    expect(attrs).toEqual({ summary: "", open: true });
    editor.destroy();
  });
});
