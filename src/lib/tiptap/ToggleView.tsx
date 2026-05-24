import { NodeViewWrapper, NodeViewContent, NodeViewProps } from "@tiptap/react";
import { ChevronRight } from "lucide-react";

/**
 * Collapsible block. The chevron expands/collapses the body in-editor.
 * The body's `display: none` hides it visually when collapsed — but if
 * the editor's selection lives inside the body when that happens, the
 * cursor would end up in hidden DOM and the editor would appear frozen.
 * `toggleOpen()` guards against that by moving the cursor out first.
 *
 * The summary is an editable text input rather than a TipTap content
 * node — toggle summaries are short and we don't need rich text inside.
 */
export function ToggleView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const { summary, open } = node.attrs as { summary: string; open: boolean };

  /** Move the editor cursor into the first paragraph of the toggle body. */
  const focusBody = () => {
    if (typeof getPos !== "function") return;
    // Position math: getPos() = start of toggle node.
    // +1 enters the toggle's content; +1 again enters the first child node.
    const target = getPos() + 2;
    editor.chain().focus().setTextSelection(target).run();
  };

  const toggleOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    const newOpen = !open;
    // If we're collapsing and the selection is inside this node's body,
    // move it just past the toggle so the cursor doesn't end up in
    // display:none DOM (which freezes the editor).
    if (!newOpen && typeof getPos === "function") {
      const start = getPos();
      const end = start + node.nodeSize;
      const sel = editor.state.selection;
      if (sel.from > start && sel.from < end) {
        editor.chain().focus().setTextSelection(end).run();
      }
    }
    updateAttributes({ open: newOpen });
  };

  return (
    <NodeViewWrapper className="tiptap-toggle" data-toggle="" data-open={open ? "" : null}>
      <div className="tiptap-toggle-header" contentEditable={false}>
        <button
          type="button"
          className={`tiptap-toggle-chevron ${open ? "is-open" : ""}`}
          onClick={toggleOpen}
          aria-label={open ? "Collapse" : "Expand"}
        >
          <ChevronRight size={14} />
        </button>
        <input
          type="text"
          className="tiptap-toggle-summary"
          value={summary}
          placeholder="Summary"
          onChange={(e) => updateAttributes({ summary: e.target.value })}
          onKeyDown={(e) => {
            // Enter in the summary input flows the cursor into the body,
            // matching Notion's "press Enter on a heading to start typing
            // below" behavior. Without this, Enter does nothing because
            // <input type="text"> doesn't insert newlines.
            if (e.key === "Enter") {
              e.preventDefault();
              focusBody();
            }
            // Down-arrow at the end of the summary also drops into the body
            // — feels right when you're navigating with the keyboard.
            if (e.key === "ArrowDown" && e.currentTarget.selectionStart === summary.length) {
              e.preventDefault();
              focusBody();
            }
          }}
        />
      </div>
      <NodeViewContent className="tiptap-toggle-body" as="div" />
    </NodeViewWrapper>
  );
}
