import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ToggleView } from "./ToggleView";

/**
 * A collapsible block. Renders via a React node view that handles the
 * chevron + editable summary input. The body is a TipTap content hole.
 *
 * `open` is a hint about how the block should be presented when exported
 * outside the editor (HTML export, AI chat context, etc.) — inside the
 * editor the body is always shown so the cursor can land there.
 */
export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      summary: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-summary") ?? "",
        renderHTML: (attrs) => (attrs.summary ? { "data-summary": attrs.summary } : {}),
      },
      open: {
        default: true,
        parseHTML: (el) => el.getAttribute("data-open") !== null,
        renderHTML: (attrs) => (attrs.open ? { "data-open": "" } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-toggle]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-toggle": "" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },
});
