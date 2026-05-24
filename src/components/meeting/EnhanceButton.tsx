import { useState, useRef, useEffect } from "react";
import { Sparkles, ChevronDown, Loader2, Undo2, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { generatedNotesToTiptap } from "../../lib/tiptap/generatedNotesToTiptap";

interface EnhanceButtonProps {
  meetingId: string;
  /** Current raw note content (TipTap JSON string) to preserve for undo */
  currentContent: string | undefined;
  /** Callback to inject AI-enhanced content into the editor */
  onEnhanced: (enhancedJson: string, rawMarkdown: string) => void;
  /** Whether enhancement has been applied (shows undo) */
  isEnhanced: boolean;
  /** Callback to undo enhancement */
  onUndoEnhance: () => void;
  /** Called when the enhancing loading state changes */
  onEnhancingChange?: (isEnhancing: boolean) => void;
  /** "ghost" renders as a subtle outline button instead of the filled accent style */
  variant?: "default" | "ghost";
  /** Optional ref to imperatively trigger the default enhance flow */
  triggerRef?: React.MutableRefObject<(() => void) | null>;
}

interface EnhanceTemplate {
  id: string;
  label: string;
  prompt: string;
}

const BUILT_IN_TEMPLATES: EnhanceTemplate[] = [
  {
    id: "quick-summary",
    label: "Quick Summary",
    prompt:
      "Based on the meeting transcript, create a brief summary with: a 2-3 sentence overview, key discussion points as bullet points, and any action items. Format as clean bullet points.",
  },
  {
    id: "detailed-notes",
    label: "Detailed Notes",
    prompt:
      "Based on the meeting transcript, create comprehensive notes organized by topic. Include: discussion context, decisions made, action items with assignees, and follow-up items. Format with clear headings and bullet points.",
  },
  {
    id: "action-items",
    label: "Action Items Only",
    prompt:
      "Extract all action items, commitments, and follow-ups from this meeting. For each item include: the task, who is responsible (if mentioned), and any deadline. Format as a checklist.",
  },
];

export function EnhanceButton({
  meetingId,
  currentContent,
  onEnhanced,
  isEnhanced,
  onUndoEnhance,
  onEnhancingChange,
  variant = "default",
  triggerRef,
}: EnhanceButtonProps) {
  const queryClient = useQueryClient();
  const [showDropdown, setShowDropdown] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [focusHint, setFocusHint] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<EnhanceTemplate>(BUILT_IN_TEMPLATES[0]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch custom templates from the backend
  const { data: customTemplates = [] } = useQuery({
    queryKey: ["templates"],
    queryFn: ipc.listTemplates,
  });

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showDropdown]);

  const handleEnhance = async (_template?: EnhanceTemplate) => {
    setShowDropdown(false);
    setIsEnhancing(true);
    onEnhancingChange?.(true);

    try {
      // Pull whatever the user has typed into the editor — passed straight to the AI as
      // user_notes, no in-frontend prompt assembly. The backend builds the full prompt.
      let userNotes = "";
      if (currentContent) {
        try {
          const parsed = JSON.parse(currentContent);
          userNotes = extractPlainText(parsed);
        } catch { /* leave empty */ }
      }

      const generated = await ipc.generateMeetingNotes(meetingId, userNotes);
      const doc = generatedNotesToTiptap(generated);
      const tiptapJsonStr = JSON.stringify(doc);

      // rawMarkdown is what the animation overlay types out. Build a quick plaintext
      // rendering of the structured output for that purpose.
      const rawMarkdown = [
        generated.summary,
        ...generated.sections.flatMap((s) => [`## ${s.heading}`, ...s.bullets.map((b) => `- ${b}`)]),
        generated.action_items.length ? "## Action Items" : "",
        ...generated.action_items.map((a) => {
          const suffix = [a.assignee, a.deadline].filter(Boolean).join(" — ");
          return suffix ? `- ${a.task} (${suffix})` : `- ${a.task}`;
        }),
      ].filter(Boolean).join("\n\n");

      onEnhanced(tiptapJsonStr, rawMarkdown);

      // Save AI notes as TipTap JSON in generated_content
      const noteData = await ipc.getNoteByMeeting(meetingId);
      if (noteData?.id) {
        await ipc.updateNoteGeneratedContent(noteData.id, tiptapJsonStr);
      }
      queryClient.invalidateQueries({ queryKey: ["note", meetingId] });
      toast.success("Notes enhanced");
    } catch (e) {
      console.error("Enhancement failed:", e);
      toast.error("Enhancement failed: " + String(e));
    } finally {
      setIsEnhancing(false);
      onEnhancingChange?.(false);
    }
  };

  // Keep triggerRef in sync with latest handleEnhance closure
  // NOTE: must be before any early return to satisfy Rules of Hooks
  const handleEnhanceRef = useRef(handleEnhance);
  handleEnhanceRef.current = handleEnhance;
  useEffect(() => {
    if (!triggerRef) return;
    triggerRef.current = () => handleEnhanceRef.current();
    return () => { if (triggerRef) triggerRef.current = null; };
  }, [triggerRef]);

  if (isEnhanced) {
    return (
      <button
        onClick={onUndoEnhance}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-bg-tertiary text-text-muted hover:text-text-primary hover:bg-bg-hover border border-border transition-colors shrink-0"
        title="Revert to your original notes"
      >
        <Undo2 size={13} />
        Undo
      </button>
    );
  }

  const isGhost = variant === "ghost";

  return (
    <div className="relative shrink-0" ref={dropdownRef}>
      <div className="flex items-center">
        {/* Main enhance button */}
        <button
          onClick={() => handleEnhance()}
          disabled={isEnhancing}
          className={
            isGhost
              ? "flex items-center gap-1 px-2 py-1.5 rounded-l-lg text-xs font-medium border border-r-0 border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              : "enhance-btn flex items-center gap-1.5 px-3.5 py-1.5 rounded-l-lg text-sm font-medium transition-all"
          }
        >
          {isEnhancing ? (
            <Loader2 size={13} className={isGhost ? "animate-spin" : "enhance-loading"} />
          ) : (
            <Sparkles size={13} />
          )}
          {isEnhancing ? "Enhancing..." : "Enhance Notes"}
        </button>
        {/* Dropdown trigger */}
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          disabled={isEnhancing}
          className={
            isGhost
              ? "p-1.5 rounded-r-lg border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              : "p-1.5 rounded-r-lg enhance-btn border-l border-white/20 transition-colors hover:brightness-110"
          }
          title="Choose template"
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {/* Dropdown — opens upward since button lives in the bottom toolbar */}
      {showDropdown && (
        <div className="menu-dropdown absolute left-0 bottom-full mb-1.5 w-72 border rounded-lg shadow-xl z-50 overflow-hidden" style={{ background: "var(--popup-bg)", borderColor: "var(--popup-border)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
          {/* Focus hint */}
          <div className="px-3 pt-3 pb-2">
            <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider block mb-1.5">
              Emphasize (optional)
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={focusHint}
                onChange={(e) => setFocusHint(e.target.value)}
                placeholder="e.g., action items, technical decisions..."
                className="flex-1 bg-bg-tertiary text-text-primary text-xs rounded-md px-2.5 py-1.5 border border-border focus:outline-none focus:border-accent placeholder:text-text-muted"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleEnhance(selectedTemplate);
                  }
                }}
              />
              {focusHint && (
                <button
                  onClick={() => setFocusHint("")}
                  className="text-text-muted hover:text-text-secondary p-0.5"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          <div className="border-t border-border">
            <div className="px-3 pt-2 pb-1">
              <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">
                Template
              </span>
            </div>
            {BUILT_IN_TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.id}
                onClick={() => {
                  setSelectedTemplate(tmpl);
                  handleEnhance(tmpl);
                }}
                className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                  selectedTemplate.id === tmpl.id
                    ? "text-accent bg-accent/5"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                }`}
              >
                <Sparkles size={12} className="shrink-0 opacity-60" />
                {tmpl.label}
              </button>
            ))}

            {/* Custom templates from backend */}
            {customTemplates.length > 0 && (
              <>
                <div className="border-t border-border mt-1 pt-1 px-3 pb-1">
                  <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    Custom
                  </span>
                </div>
                {customTemplates.slice(0, 5).map((tmpl) => (
                  <button
                    key={tmpl.id}
                    onClick={() => {
                      const custom: EnhanceTemplate = {
                        id: tmpl.id,
                        label: tmpl.name,
                        prompt: tmpl.prompt_template,
                      };
                      setSelectedTemplate(custom);
                      handleEnhance(custom);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-2"
                  >
                    <Sparkles size={12} className="shrink-0 opacity-60" />
                    {tmpl.name}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Extract plain text from TipTap JSON for AI context */
function extractPlainText(doc: Record<string, unknown>): string {
  const lines: string[] = [];
  const content = doc.content as Array<Record<string, unknown>> | undefined;
  if (!content) return "";

  for (const node of content) {
    const nodeContent = node.content as Array<{ text?: string }> | undefined;
    const text = nodeContent?.map((c) => c.text || "").join("") || "";
    if (node.type === "heading") {
      lines.push(text);
    } else if (node.type === "paragraph") {
      lines.push(text);
    } else if (node.type === "bulletList" || node.type === "orderedList") {
      const items = node.content as Array<Record<string, unknown>> | undefined;
      if (items) {
        for (const item of items) {
          const paraContent = (item.content as Array<Record<string, unknown>> | undefined)?.[0];
          const itemText = (paraContent?.content as Array<{ text?: string }> | undefined)
            ?.map((c) => c.text || "")
            .join("") || "";
          lines.push(`- ${itemText}`);
        }
      }
    }
  }

  return lines.join("\n");
}
