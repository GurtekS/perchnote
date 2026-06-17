import { useState, useRef, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Sparkles, ChevronDown, Loader2, RefreshCw, Undo2, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { runEnhance } from "../../lib/enhance";

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

// The dropdown lists the REAL templates from the database (six seeded
// per-meeting-type ones plus the user's own) — the old hardcoded trio
// never reached the backend (plan v2 rank 1).

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
  const navigate = useNavigate();
  const [showDropdown, setShowDropdown] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [focusHint, setFocusHint] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<EnhanceTemplate | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch custom templates from the backend
  const { data: customTemplates = [] } = useQuery({
    queryKey: ["templates"],
    queryFn: ipc.listTemplates,
  });

  // Preflight: enhancement needs SOME configured provider — Anthropic,
  // Ollama, or Apple Intelligence. Gating on the Anthropic key alone left
  // Ollama/Apple users with a permanently disabled button and wrong advice
  // (friction audit #2).
  const { data: aiConfigured } = useQuery({
    queryKey: ["ai-configured"],
    queryFn: ipc.checkAiConfigured,
    staleTime: 60_000,
  });
  // Unknown (still loading) counts as present so the button doesn't flash disabled.
  const hasApiKey = aiConfigured === undefined || aiConfigured;
  const missingKeyHint = "Set up an AI provider in Settings → AI to enable enhancement";

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

  // The route component is REUSED across meeting navigation, so this
  // button's props swap to the next meeting while an enhance is still in
  // flight. Capture who the run was for and compare against the latest
  // prop on resolve — without this, meeting A's AI notes played the
  // enhance animation INTO meeting B's view and one keystroke persisted
  // them there (whole-app review P1).
  const latestMeetingIdRef = useRef(meetingId);
  latestMeetingIdRef.current = meetingId;

  const handleEnhance = async (template?: EnhanceTemplate) => {
    const startedFor = meetingId;
    const chosen = template ?? selectedTemplate;
    setShowDropdown(false);
    setIsEnhancing(true);
    onEnhancingChange?.(true);

    try {
      // Shared flow (also used by instant recap): generate, convert, persist
      // atomically, refresh caches. The live editor content rides along so
      // unsaved typing still reaches the AI.
      const { generated, tiptapJson, rawMarkdown } = await runEnhance(queryClient, meetingId, {
        templateId: chosen?.id ?? null,
        currentContent: currentContent ?? null,
        focusHint,
      });

      if (latestMeetingIdRef.current !== startedFor) {
        // The user moved on — the DB write (keyed to the right meeting)
        // already happened inside runEnhance; the UI callback must not
        // fire against whichever meeting is on screen now.
        return;
      }
      onEnhanced(tiptapJson, rawMarkdown);

      // Post-enhance pathing: extracted tasks are the natural next stop.
      const n = generated.action_items.length;
      if (n > 0) {
        toast.action(
          `Notes enhanced. ${n} action item${n === 1 ? "" : "s"} captured.`,
          "View tasks",
          () => navigate({ to: "/tasks" }),
        );
      } else {
        toast.success("Notes enhanced");
      }
    } catch (e) {
      console.error("Enhancement failed:", e);
      if (latestMeetingIdRef.current === startedFor) {
        toast.error(toUserMessage(e, "Enhancement failed"), "Enhancement failed");
      }
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
      <div className="relative flex shrink-0 items-center gap-1" ref={dropdownRef}>
        <button
          onClick={onUndoEnhance}
          className="btn btn-secondary shrink-0"
          title="Revert to your original notes"
        >
          <Undo2 size={13} />
          Undo
        </button>
        {/* Re-run with a different template — raw notes are never touched
            (generated_content is replaced; raw_content rides along). */}
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          disabled={isEnhancing || !hasApiKey}
          className="flex h-[26px] w-7 items-center justify-center rounded-lg border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
          title="Re-run with a different template"
          aria-label="Re-run enhancement with a different template"
        >
          {isEnhancing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
        {showDropdown && (
          <div className="glass-float menu-dropdown absolute left-0 bottom-full mb-1.5 w-64 rounded-lg z-50 overflow-hidden">
            <div className="px-3 pt-2 pb-1">
              <span className="section-label">Re-run with template</span>
            </div>
            {customTemplates.map((tmpl) => (
              <button
                key={tmpl.id}
                onClick={() => {
                  const t: EnhanceTemplate = { id: tmpl.id, label: tmpl.name, prompt: tmpl.prompt_template };
                  setSelectedTemplate(t);
                  handleEnhance(t);
                }}
                className="w-full text-left px-3 py-2 text-sm text-text-secondary transition-colors flex items-center gap-2 hover:text-text-primary hover:bg-bg-hover"
              >
                <Sparkles size={12} className="shrink-0 opacity-60" />
                {tmpl.name}
                {tmpl.is_default && <span className="text-footnote text-text-muted">default</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const isGhost = variant === "ghost";

  return (
    <div className="relative shrink-0" ref={dropdownRef}>
      <div className="flex items-center">
        {/* Main enhance button */}
        <button
          onClick={() => handleEnhance()}
          disabled={isEnhancing || !hasApiKey}
          title={hasApiKey ? undefined : missingKeyHint}
          className={
            isGhost
              ? "flex items-center gap-1 px-2 py-1.5 rounded-l-lg text-xs font-medium border border-r-0 border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              : "enhance-btn flex items-center gap-1.5 px-3.5 py-1.5 rounded-l-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          }
        >
          {isEnhancing ? (
            <Loader2 size={13} className={isGhost ? "animate-spin" : "enhance-loading"} />
          ) : (
            <Sparkles size={13} />
          )}
          Enhance notes
        </button>
        {/* Dropdown trigger */}
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          disabled={isEnhancing || !hasApiKey}
          className={
            isGhost
              ? "p-1.5 rounded-r-lg border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              : "p-1.5 rounded-r-lg enhance-btn border-l border-white/20 transition-colors hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          }
          title={hasApiKey ? "Choose template" : missingKeyHint}
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {/* Dropdown — opens upward since button lives in the bottom toolbar */}
      {showDropdown && (
        <div className="glass-float menu-dropdown absolute left-0 bottom-full mb-1.5 w-72 rounded-lg z-50 overflow-hidden">
          {/* Focus hint */}
          <div className="px-3 pt-3 pb-2">
            <label className="section-label block mb-1.5">
              Emphasize (optional)
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={focusHint}
                onChange={(e) => setFocusHint(e.target.value)}
                placeholder="e.g., action items, technical decisions…"
                className="flex-1 bg-bg-tertiary text-text-primary text-xs rounded-md px-2.5 py-1.5 border border-border focus:outline-none focus:border-accent placeholder:text-text-muted"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleEnhance(selectedTemplate ?? undefined);
                  }
                }}
              />
              {focusHint && (
                <button
                  onClick={() => setFocusHint("")}
                  aria-label="Clear focus hint"
                  className="text-text-muted hover:text-text-secondary p-0.5"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          <div className="border-t border-border">
            <div className="px-3 pt-2 pb-1">
              <span className="section-label">
                Template
              </span>
            </div>
            {customTemplates.map((tmpl) => (
              <button
                key={tmpl.id}
                onClick={() => {
                  const t: EnhanceTemplate = { id: tmpl.id, label: tmpl.name, prompt: tmpl.prompt_template };
                  setSelectedTemplate(t);
                  handleEnhance(t);
                }}
                className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                  selectedTemplate?.id === tmpl.id
                    ? "text-accent bg-accent/5"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                }`}
              >
                <Sparkles size={12} className="shrink-0 opacity-60" />
                {tmpl.name}
                {tmpl.is_default && <span className="text-footnote text-text-muted">default</span>}
              </button>
            ))}
            {customTemplates.length === 0 && (
              <p className="px-3 py-2 text-xs text-text-muted">No templates yet. Create one in Settings.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

