import { useEditor, EditorContent, Editor } from "@tiptap/react";
import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef, useState } from "react";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, CheckSquare, Heading1, Heading2,
  Code, Highlighter, Quote,
} from "lucide-react";
import { editorExtensions } from "../../lib/tiptap/extensions";

interface NoteEditorProps {
  content?: string;
  onUpdate?: (json: string) => void;
  editable?: boolean;
  placeholder?: string;
  /** Notepad-first mode: full-bleed, borderless */
  notepadMode?: boolean;
  /** Show formatting toolbar (default: true when notepadMode) */
  showToolbar?: boolean;
}

export interface NoteEditorHandle {
  getEditor: () => Editor | null;
  setContent: (json: string) => void;
}

function parseContent(content: string | undefined) {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
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
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
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
  return <div className="w-px h-4 bg-border mx-0.5 shrink-0" />;
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
    <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-border bg-bg-secondary shrink-0">
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
        title="Heading 1"
      >
        <Heading1 size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        title="Heading 2"
      >
        <Heading2 size={13} />
      </ToolbarButton>

      <Separator />

      {/* Lists */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        title="Bullet list"
      >
        <List size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        title="Numbered list"
      >
        <ListOrdered size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        active={editor.isActive("taskList")}
        title="Task list"
      >
        <CheckSquare size={13} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
        title="Blockquote"
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
      placeholder: _placeholder,
      notepadMode = false,
      showToolbar,
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

    const debouncedUpdate = useCallback((json: string) => {
      if (suppressUpdatesRef.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onUpdateRef.current?.(json);
      }, 500);
    }, []);

    const editor = useEditor({
      extensions: editorExtensions,
      content: parseContent(content),
      editable,
      editorProps: {
        attributes: {
          class: notepadMode
            ? "prose prose-invert prose-sm max-w-none min-h-[calc(100vh-200px)] focus:outline-none"
            : "prose prose-invert prose-sm max-w-none min-h-[300px] focus:outline-none px-4 py-3",
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
