import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { getRecordingElapsedMs } from "../recordingClock";

/** Top-level block types that receive a silent `t_ms` anchor. */
const ANCHORED_TYPES = ["paragraph", "heading", "blockquote", "codeBlock"];

/**
 * Granola-style temporal alignment (plan v7 capture 7): while recording,
 * every block the user touches is silently stamped with the elapsed time.
 * The attr is invisible (no HTML rendering, no UI) and rides the stored
 * JSON; Enhance serializes it as a [m:ss] line prefix so the AI can match
 * each typed fragment to the transcript moment it reacts to.
 */
export const BlockTimeAnchors = Extension.create({
  name: "blockTimeAnchors",

  addGlobalAttributes() {
    return [
      {
        types: ANCHORED_TYPES,
        attributes: {
          t_ms: {
            default: null,
            rendered: false, // JSON keeps it; HTML output stays clean
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockTimeAnchors"),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const ms = getRecordingElapsedMs();
          if (ms == null) return null;

          // Top-level blocks touched by this change and not yet stamped.
          // Pre-existing agenda blocks get stamped at first mid-recording
          // edit — "when you touched it" is the honest anchor.
          const touched = new Set<number>();
          for (const tr of transactions) {
            if (!tr.docChanged) continue;
            tr.mapping.maps.forEach((stepMap) => {
              stepMap.forEach((_fromA, _toA, fromB, toB) => {
                newState.doc.nodesBetween(
                  Math.min(fromB, newState.doc.content.size),
                  Math.min(toB, newState.doc.content.size),
                  (node, pos, parent) => {
                    if (parent === newState.doc && ANCHORED_TYPES.includes(node.type.name)) {
                      touched.add(pos);
                    }
                    return parent === newState.doc; // only descend one level
                  },
                );
              });
            });
          }
          if (touched.size === 0) return null;

          let tr = null as ReturnType<typeof newState.tr.setNodeMarkup> | null;
          for (const pos of touched) {
            const node = newState.doc.nodeAt(pos);
            if (!node || node.attrs.t_ms != null) continue;
            tr = (tr ?? newState.tr).setNodeMarkup(pos, undefined, {
              ...node.attrs,
              t_ms: ms,
            });
          }
          if (tr) tr.setMeta("addToHistory", false); // stamps aren't undo steps
          return tr;
        },
      }),
    ];
  },
});
