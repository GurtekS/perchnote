import { Document } from "@tiptap/extension-document";

/**
 * Extend the root Document node with a `tags` attribute. AI-enhanced
 * documents store their tag list here so AiNotesHeader can render pills
 * without having to inspect node content.
 */
export const DocumentAttrs = Document.extend({
  addAttributes() {
    return {
      tags: {
        default: [] as string[],
        parseHTML: () => [],
        renderHTML: () => ({}),
      },
    };
  },
});
