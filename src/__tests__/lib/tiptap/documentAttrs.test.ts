import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { DocumentAttrs } from "../../../lib/tiptap/documentAttrs";

describe("DocumentAttrs", () => {
  it("round-trips a tags attribute on the root document", () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ document: false }), DocumentAttrs],
      content: { type: "doc", attrs: { tags: ["alpha", "beta"] }, content: [{ type: "paragraph" }] },
    });
    const json = editor.getJSON();
    expect(json.attrs).toEqual({ tags: ["alpha", "beta"] });
    editor.destroy();
  });

  it("defaults tags to an empty array", () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ document: false }), DocumentAttrs],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    expect(editor.getJSON().attrs).toEqual({ tags: [] });
    editor.destroy();
  });
});
