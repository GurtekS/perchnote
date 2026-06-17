/** Structured AI-notes payload, mirrors the Rust GeneratedNotes struct. */
export interface GeneratedNotes {
  title: string;
  summary: string;
  sections: { heading: string; bullets: string[] }[];
  action_items: { task: string; assignee: string | null; deadline: string | null; source_start_ms?: number | null }[];
  tags: string[];
  /** Validated per-bullet transcript provenance (plan v3 rank 7). */
  bullet_anchors?: { section_index: number; bullet_index: number; source_start_ms: number }[];
  /** Enhance receipt (plan v10 #2) — stamped by the backend after
   *  generation: which provider/model ran and the transcript hash the
   *  prompt was built from. Handed back at persist time. */
  receipt?: { provider: string; model: string; transcript_sha: string | null } | null;
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

  // Per-bullet provenance: anchored bullets end with a "⏱ m:ss" mark —
  // the same plain-text shape the ⌘-click replay handler already seeks on.
  const anchorMs = new Map<string, number>();
  for (const a of notes.bullet_anchors ?? []) {
    anchorMs.set(`${a.section_index}:${a.bullet_index}`, a.source_start_ms);
  }

  (notes.sections ?? []).forEach((section, si) => {
    if (!section.heading) return;
    content.push({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: section.heading }],
    });
    if (section.bullets?.length) {
      content.push({
        type: "bulletList",
        content: section.bullets.map((b, bi) => {
          const ms = anchorMs.get(`${si}:${bi}`);
          const text =
            ms != null
              ? `${b}  ⏱ ${Math.floor(ms / 60000)}:${(Math.floor(ms / 1000) % 60)
                  .toString()
                  .padStart(2, "0")}`
              : b;
          return {
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text }],
            }],
          };
        }),
      });
    }
  });

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
          source_start_ms: item.source_start_ms ?? null,
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
