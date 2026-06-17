import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { DocumentAttrs } from "./documentAttrs";
import { Summary } from "./summary";
import { ActionItem } from "./actionItem";
import { TimestampChip } from "./timestampChip";
import { PastedImage } from "./pastedImage";
import { BlockTimeAnchors } from "./blockTimeAnchors";
import { Callout } from "./callout";
import { Toggle } from "./toggle";
import { SlashCommand } from "./slashCommand";
import { MentionExtension } from "./mention";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";

const SAFE_LINK_SCHEMES = ["http", "https", "mailto"];

export const DEFAULT_PLACEHOLDER = "Jot your notes here during the meeting...";

/** TaskItem + ⌘⏎ to toggle the checkbox at the cursor — action items are
 *  the most-typed structure during calls, and reaching for the mouse to
 *  check one breaks listening flow (plan v7 capture item 4). */
const TaskItemWithToggle = TaskItem.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      "Mod-Enter": () => {
        const { $from } = this.editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name === this.name) {
            const pos = $from.before(depth);
            return this.editor.commands.command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked });
              return true;
            });
          }
        }
        return false; // not in a task item — let other bindings run
      },
    };
  },
});

export interface EditorExtensionOptions {
  /** Static string, or a function read at every paint — lets the editor
   *  swap copy (e.g. the recording capture contract) without rebuilding. */
  placeholder?: string | (() => string);
}

export function buildEditorExtensions(opts: EditorExtensionOptions = {}) {
  const ph = opts.placeholder ?? DEFAULT_PLACEHOLDER;
  return [
    StarterKit.configure({
      document: false, // we use our DocumentAttrs subclass instead
      heading: { levels: [1, 2, 3] },
    }),
    DocumentAttrs,
    Summary,
    ActionItem,
    TimestampChip,
    PastedImage,
    BlockTimeAnchors,
    Callout,
    Toggle,
    SlashCommand,
    MentionExtension,
    Placeholder.configure({
      placeholder: typeof ph === "function" ? () => ph() : ph,
    }),
    TaskList,
    TaskItemWithToggle.configure({ nested: true }),
    Underline,
    Highlight.configure({ multicolor: false }),
    Link.configure({
    openOnClick: false,
    autolink: true,
    protocols: SAFE_LINK_SCHEMES,
    HTMLAttributes: {
      class: "text-accent underline cursor-pointer",
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    },
    isAllowedUri: (url: string) => {
      try {
        const parsed = new URL(url, "about:blank");
        return SAFE_LINK_SCHEMES.some((s) => parsed.protocol === `${s}:`);
      } catch {
        return false;
      }
    },
  }),
  ];
}

export const editorExtensions = buildEditorExtensions();
