import type { Editor, Range } from "@tiptap/core";

export interface SlashCommandItem {
  label: string;
  description: string;
  aliases: string[];
  command: (args: { editor: Editor; range: Range }) => void;
}

export const slashCommandItems: SlashCommandItem[] = [
  {
    label: "Heading 1", description: "Large section heading", aliases: ["h1"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    label: "Heading 2", description: "Medium section heading", aliases: ["h2"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    label: "Heading 3", description: "Small section heading", aliases: ["h3"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
  },
  {
    label: "Bulleted list", description: "Items with bullet points", aliases: ["bullet", "ul"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    label: "Numbered list", description: "Items numbered 1., 2., 3.", aliases: ["ol", "ordered"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    label: "Task list", description: "Items with checkboxes", aliases: ["todo", "checkbox"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    label: "Quote", description: "Block quote", aliases: ["blockquote"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    label: "Divider", description: "Horizontal rule", aliases: ["hr", "rule"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    label: "Code block", description: "Monospaced code", aliases: ["code", "```"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    label: "Callout (info)", description: "Highlighted box (blue)", aliases: ["info", "note"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).wrapIn("callout", { variant: "info" }).run(),
  },
  {
    label: "Callout (warn)", description: "Highlighted box (yellow)", aliases: ["warn", "warning"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).wrapIn("callout", { variant: "warn" }).run(),
  },
  {
    label: "Callout (tip)", description: "Highlighted box (green)", aliases: ["tip"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).wrapIn("callout", { variant: "tip" }).run(),
  },
  {
    label: "Toggle", description: "Collapsible details block", aliases: ["details", "fold"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).wrapIn("toggle", { summary: "", open: true }).run(),
  },
];

export function filterItems(query: string): SlashCommandItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return slashCommandItems;
  return slashCommandItems.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.aliases.some((a) => a.toLowerCase().includes(q))
  );
}
