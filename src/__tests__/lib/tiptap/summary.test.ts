import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Summary } from "../../../lib/tiptap/summary";

describe("Summary node", () => {
  it("round-trips through JSON with inline text", () => {
    const editor = new Editor({
      extensions: [StarterKit, Summary],
      content: {
        type: "doc",
        content: [
          { type: "summary", content: [{ type: "text", text: "Hello world." }] },
          { type: "paragraph" },
        ],
      },
    });
    const json = editor.getJSON();
    expect(json.content?.[0]).toMatchObject({
      type: "summary",
      content: [{ type: "text", text: "Hello world." }],
    });
    editor.destroy();
  });

  it("renders an HTML element with the data-summary marker", () => {
    const editor = new Editor({
      extensions: [StarterKit, Summary],
      content: {
        type: "doc",
        content: [{ type: "summary", content: [{ type: "text", text: "x" }] }],
      },
    });
    expect(editor.getHTML()).toContain('data-summary=""');
    editor.destroy();
  });
});
