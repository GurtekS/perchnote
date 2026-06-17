import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { TimestampChipView } from "./TimestampChipView";

/**
 * A ⌘D mark as a real inline node (plan v7 capture 6). The old marks were
 * plain text "⏱ m:ss — " replayed via a regex ⌘-click handler: edits broke
 * them and the gesture was undiscoverable. A chip survives editing, reads
 * as one object to VoiceOver, and replays on plain click.
 */
export const TimestampChip = Node.create({
  name: "timestampChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      ms: {
        default: 0,
        parseHTML: (el) => parseInt(el.getAttribute("data-ms") ?? "0", 10),
        renderHTML: (attrs) => ({ "data-ms": String(attrs.ms) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-timestamp-chip]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-timestamp-chip": "" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TimestampChipView);
  },
});

export function formatChipMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, "0")}`;
}
