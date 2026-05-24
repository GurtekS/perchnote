// src/__tests__/lib/tiptap/callout.test.ts
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Callout } from "../../../lib/tiptap/callout";

describe("Callout node", () => {
  it("round-trips the variant attribute", () => {
    const editor = new Editor({
      extensions: [StarterKit, Callout],
      content: {
        type: "doc",
        content: [{
          type: "callout",
          attrs: { variant: "warn" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Heads up." }] }],
        }],
      },
    });
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "callout",
      attrs: { variant: "warn" },
    });
    editor.destroy();
  });

  it("defaults variant to 'info'", () => {
    const editor = new Editor({
      extensions: [StarterKit, Callout],
      content: {
        type: "doc",
        content: [{ type: "callout", content: [{ type: "paragraph" }] }],
      },
    });
    expect((editor.getJSON().content?.[0] as { attrs: { variant: string } }).attrs.variant).toBe("info");
    editor.destroy();
  });
});
