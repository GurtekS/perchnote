import { Node, mergeAttributes } from "@tiptap/core";

/**
 * A distinctively-styled block at the top of AI-generated notes. Rendered
 * as a card with a 3px accent left bar and a small "SUMMARY" label
 * (provided by CSS `::before`). Content is `inline*` so it behaves like
 * an editable paragraph.
 */
export const Summary = Node.create({
  name: "summary",
  group: "block",
  content: "inline*",
  defining: true,

  parseHTML() {
    return [{ tag: "div[data-summary]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-summary": "", class: "tiptap-summary" }),
      0,
    ];
  },
});
