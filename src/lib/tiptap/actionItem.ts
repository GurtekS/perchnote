// src/lib/tiptap/actionItem.ts
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ActionItemView } from "./ActionItemView";

/**
 * An AI-generated action item. Atomic (not editable inline) with four
 * attributes. Rendered via a React node view (see ActionItemView).
 */
export const ActionItem = Node.create({
  name: "actionItem",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      task:     { default: "" },
      assignee: { default: null },
      deadline: { default: null },
      done:     { default: false },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-action-item]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-action-item": "" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ActionItemView);
  },
});
