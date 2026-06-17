/**
 * THE keyboard-shortcut reference — consumed by both the ⌘/ overlay and
 * Settings → Shortcuts. The two used to be separate hand-maintained lists,
 * and the Settings one had quietly fallen seven shortcuts behind
 * (friction audit #13).
 */
export interface ShortcutGroup {
  title: string;
  items: Array<[keys: string, description: string]>;
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigate",
    items: [
      ["⌘1–⌘5", "Meetings · Tasks · Folders · Calendar · Insights"],
      ["⌘[ / ⌘]", "Back / forward through your path"],
      ["⌘K", "Search everything"],
      ["⌘F", "Filter the meeting list"],
      ["F6", "Cycle panes — list · notes · transcript"],
      ["↑↓", "Move through the meeting list"],
    ],
  },
  {
    title: "Capture",
    items: [
      ["⌘N", "New meeting + start recording"],
      ["⌘⇧N", "Quick voice note — new meeting, recording instantly"],
      ["⌘D", "Mark this moment — click the chip to replay"],
      ["⌘⇧D", "Quote what was just said into your notes"],
      ["[] ⎵", "Checkbox — # heading, - bullet, > quote work too"],
      ["⌘⏎", "Toggle the checkbox at the cursor"],
      ["⌘T", "Transcript drawer"],
      ["⌘\\", "Focus mode"],
      ["⌘B", "Toggle sidebar"],
    ],
  },
  {
    title: "Assist",
    items: [
      ["⌘E", "Enhance notes (on a meeting)"],
      ["⌘J", "Ask AI"],
      ["⌘,", "Settings"],
      ["⌘/", "This shortcut reference"],
      ["Esc", "Close the topmost overlay"],
    ],
  },
];
