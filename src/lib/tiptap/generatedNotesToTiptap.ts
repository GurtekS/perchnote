/** Structured AI-notes payload, mirrors the Rust GeneratedNotes struct. */
export interface GeneratedNotes {
  title: string;
  summary: string;
  sections: { heading: string; bullets: string[] }[];
  action_items: { task: string; assignee: string | null; deadline: string | null }[];
  tags: string[];
}

/** A minimally-typed TipTap doc, just enough to assert on in tests. */
export interface TipTapDoc {
  type: "doc";
  attrs?: { tags?: string[] };
  content: unknown[];
}

/** Build a TipTap document from a structured AI response. */
export function generatedNotesToTiptap(notes: GeneratedNotes): TipTapDoc {
  const content: unknown[] = [];

  if (notes.summary && notes.summary.trim()) {
    content.push({
      type: "summary",
      content: [{ type: "text", text: notes.summary }],
    });
  }

  for (const section of notes.sections ?? []) {
    if (!section.heading) continue;
    content.push({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: section.heading }],
    });
    if (section.bullets?.length) {
      content.push({
        type: "bulletList",
        content: section.bullets.map((b) => ({
          type: "listItem",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: b }],
          }],
        })),
      });
    }
  }

  if (notes.action_items?.length) {
    content.push({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Action Items" }],
    });
    for (const item of notes.action_items) {
      content.push({
        type: "actionItem",
        attrs: {
          task:     item.task ?? "",
          assignee: item.assignee ?? null,
          deadline: item.deadline ?? null,
          done:     false,
        },
      });
    }
  }

  // TipTap requires at least one node — fall back to an empty paragraph if everything was missing.
  if (content.length === 0) content.push({ type: "paragraph" });

  return {
    type: "doc",
    attrs: { tags: notes.tags ?? [] },
    content,
  };
}
