import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { DocumentAttrs } from "./documentAttrs";
import { Summary } from "./summary";
import { ActionItem } from "./actionItem";
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

export const editorExtensions = [
  StarterKit.configure({
    document: false, // we use our DocumentAttrs subclass instead
    heading: { levels: [1, 2, 3] },
  }),
  DocumentAttrs,
  Summary,
  ActionItem,
  Callout,
  Toggle,
  SlashCommand,
  MentionExtension,
  Placeholder.configure({
    placeholder: "Jot your notes here during the meeting...",
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
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
