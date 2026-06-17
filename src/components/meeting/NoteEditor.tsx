import { useEditor, EditorContent, Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useCallback, useImperativeHandle, forwardRef, useState } from "react";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, CheckSquare, Heading1, Heading2,
  Code, Highlighter, Quote,
} from "lucide-react";
import { buildEditorExtensions, DEFAULT_PLACEHOLDER } from "../../lib/tiptap/extensions";
import { sanitizeTiptapDoc } from "../../lib/tiptap/sanitizeTiptapDoc";
import { handleImagePaste } from "../../lib/tiptap/pastedImage";
import { toast } from "../../stores/toastStore";

interface NoteEditorProps {
  content?: string;
  onUpdate?: (json: string) => void;
  editable?: boolean;
  placeholder?: string;
  /** Notepad-first mode: full-bleed, borderless */
  notepadMode?: boolean;
  /** Show formatting toolbar (default: true when notepadMode) */
  showToolbar?: boolean;
  /** When set, ⌘V of a screenshot is saved as this meeting's attachment and
   *  inserted inline (plan v9 #13). Absent → image pastes are ignored. */
  meetingId?: string;
}

export interface NoteEditorHandle {
  getEditor: () => Editor | null;
  setContent: (json: string) => void;
}

function parseContent(content: string | undefined) {
  if (!content) return undefined;
  try {
    return sanitizeTiptapDoc(JSON.parse(content));
  } catch {
    return undefined;
  }
}

// ─── Formatting Toolbar ───────────────────────────────────────────────────────

function ToolbarButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault(); // keep editor focus
        onClick();
      }}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
        active
          ? "bg-accent/15 text-accent"
          : "text-text-muted hover:text-text-primary hover:bg-bg-hover"
      }`}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <div className="mx-1 h-3.5 w-px shrink-0 bg-border-subtle" />;
}

function FormattingToolbar({ editor }: { editor: Editor | null }) {
  // Subscribe to editor state changes so toolbar reflects active marks
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => setTick((t) => t + 1);
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  if (!editor) return null;

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 flex w-fit flex-wrap items-center gap-0.5 rounded-lg px-0 py-1 shrink-0"
      style={{
        // A whisper of the notepad surface so the strip stays readable
        // when notes scroll beneath it, without drawing a boxed bar.
        background: "color-mix(in srgb, var(--notepad-bg) 88%, transparent)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      {/* Text style */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
        title="Bold (⌘B)"
      >
        <Bold size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
        title="Italic (⌘I)"
      >
        <Italic size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive("underline")}
        title="Underline (⌘U)"
      >
        <UnderlineIcon size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        title="Strikethrough"
      >
        <Strikethrough size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        active={editor.isActive("highlight")}
        title="Highlight"
      >
        <Highlighter size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive("code")}
        title="Inline code"
      >
        <Code size={13} />
      </ToolbarButton>

      <Separator />

      {/* Headings */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
        title="Heading 1: type # then space"
      >
        <Heading1 size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        title="Heading 2: type ## then space"
      >
        <Heading2 size={13} />
      </ToolbarButton>

      <Separator />

      {/* Lists */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        title="Bullet list: type - then space"
      >
        <List size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        title="Numbered list: type 1. then space"
      >
        <ListOrdered size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        active={editor.isActive("taskList")}
        title="Task list: type [] then space · ⌘⏎ toggles done"
      >
        <CheckSquare size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
        title="Blockquote: type > then space"
      >
        <Quote size={13} />
      </ToolbarButton>
    </div>
  );
}

// ─── NoteEditor ───────────────────────────────────────────────────────────────

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function NoteEditor(
    {
      content,
      onUpdate,
      editable = true,
      placeholder,
      notepadMode = false,
      showToolbar,
      meetingId,
    },
    ref
  ) {
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const onUpdateRef = useRef(onUpdate);
    onUpdateRef.current = onUpdate;
    // Holds content requested via setContent() before the TipTap editor is ready
    const pendingContentRef = useRef<string | null>(null);
    // Suppress onUpdate during programmatic setContent to prevent AI content
    // from overwriting the user's raw_content in the database
    const suppressUpdatesRef = useRef(false);

    // Latest content scheduled for save but not yet delivered — flushed on
    // unmount so navigating away never drops the last ≤500ms of typing.
    const pendingSaveRef = useRef<string | null>(null);

    const debouncedUpdate = useCallback((json: string) => {
      if (suppressUpdatesRef.current) return;
      pendingSaveRef.current = json;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        pendingSaveRef.current = null;
        onUpdateRef.current?.(json);
      }, 500);
    }, []);

    // The Placeholder extension reads through this ref on every paint, so
    // the copy can change live (recording swaps in the capture contract)
    // without rebuilding the editor. (The prop was silently unused before —
    // research round 5, capture item 2.)
    const placeholderRef = useRef(placeholder ?? DEFAULT_PLACEHOLDER);
    placeholderRef.current = placeholder ?? DEFAULT_PLACEHOLDER;
    const extensions = useMemo(
      () => buildEditorExtensions({ placeholder: () => placeholderRef.current }),
      [],
    );

    // editorProps are captured when TipTap initialises — read through a ref
    // so the paste handler always sees the current meeting (same pattern as
    // placeholderRef above).
    const meetingIdRef = useRef(meetingId);
    meetingIdRef.current = meetingId;

    const editor = useEditor({
      extensions,
      content: parseContent(content),
      editable,
      editorProps: {
        // ⌘V of a screenshot → saved attachment + inline image (plan v9
        // #13). Returns false for anything that isn't a PNG file, so
        // ordinary text/HTML pastes take TipTap's default path untouched.
        handlePaste: (view, event) =>
          handleImagePaste(view, event, meetingIdRef.current, {
            onError: (message) => toast.error(message),
          }),
        attributes: {
          class: notepadMode
            ? "prose prose-invert prose-sm max-w-none min-h-[calc(100vh-200px)] focus:outline-none"
            : "prose prose-invert prose-sm max-w-none min-h-[300px] focus:outline-none px-4 py-3",
          // VoiceOver reads the contenteditable itself, not the wrapper —
          // the attrs must live here (plan v6 a11y).
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "Meeting notes",
        },
      },
      onUpdate: ({ editor }) => {
        debouncedUpdate(JSON.stringify(editor.getJSON()));
      },
    });

    // Expose editor handle to parent. If editor isn't ready yet, stash the
    // content so it can be applied once TipTap initialises (see effect below).
    useImperativeHandle(ref, () => ({
      getEditor: () => editor,
      setContent: (json: string) => {
        if (editor) {
          const parsed = parseContent(json);
          if (parsed) {
            suppressUpdatesRef.current = true;
            editor.commands.setContent(parsed);
            suppressUpdatesRef.current = false;
          }
        } else {
          pendingContentRef.current = json;
        }
      },
    }), [editor]);

    // An empty doc repaints its placeholder only on the next transaction;
    // nudge one when the copy changes so recording start/stop swaps it
    // immediately.
    useEffect(() => {
      if (editor) editor.view.dispatch(editor.state.tr);
    }, [editor, placeholder]);

    // Apply any content that arrived before TipTap was ready
    useEffect(() => {
      if (editor && pendingContentRef.current) {
        const parsed = parseContent(pendingContentRef.current);
        if (parsed) {
          suppressUpdatesRef.current = true;
          editor.commands.setContent(parsed);
          suppressUpdatesRef.current = false;
        }
        pendingContentRef.current = null;
      }
    }, [editor]);

    useEffect(() => {
      if (editor && content && !editor.isFocused && !pendingContentRef.current) {
        const parsed = parseContent(content);
        if (parsed) {
          suppressUpdatesRef.current = true;
          editor.commands.setContent(parsed);
          suppressUpdatesRef.current = false;
        }
      }
    }, [content, editor]);

    useEffect(() => {
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (pendingSaveRef.current !== null) {
          onUpdateRef.current?.(pendingSaveRef.current);
          pendingSaveRef.current = null;
        }
      };
    }, []);

    const toolbar = showToolbar ?? (notepadMode && editable);

    if (notepadMode) {
      return (
        <div className="notepad-editor flex flex-col">
          {toolbar && <FormattingToolbar editor={editor} />}
          <EditorContent editor={editor} />
        </div>
      );
    }

    return (
      <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden flex flex-col">
        {toolbar && <FormattingToolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>
    );
  }
);
