// src/lib/tiptap/callout.ts
import { Node, mergeAttributes } from "@tiptap/core";

export type CalloutVariant = "info" | "warn" | "tip";

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: "info" as CalloutVariant,
        parseHTML: (el) => (el.getAttribute("data-variant") as CalloutVariant) ?? "info",
        renderHTML: (attrs) => ({ "data-variant": attrs.variant }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-callout": "", class: "tiptap-callout" }),
      0,
    ];
  },
});
