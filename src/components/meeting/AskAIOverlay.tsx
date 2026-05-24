import { useState, useRef, useEffect, useCallback } from "react";
import { Loader2, Sparkles, X, CornerDownLeft } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "../../lib/ipc";

interface AskAIOverlayProps {
  meetingId?: string | null;
  isOpen: boolean;
  onClose: () => void;
}

type Scope = "this" | "all";

export function AskAIOverlay({ meetingId, isOpen, onClose }: AskAIOverlayProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>(meetingId ? "this" : "all");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const closeOverlay = useCallback(() => {
    onClose();
    window.setTimeout(() => previousFocusRef.current?.focus(), 0);
  }, [onClose]);

  // Load recent questions for this meeting (only when a meeting is in context)
  const { data: recentMessages = [] } = useQuery({
    queryKey: ["chat", meetingId],
    queryFn: () => ipc.listChatMessages(meetingId!),
    enabled: isOpen && !!meetingId && scope === "this",
  });

  // Fetch all meetings for multi-meeting scope
  const { data: allMeetings = [] } = useQuery({
    queryKey: ["meetings"],
    queryFn: ipc.listMeetings,
    enabled: isOpen && scope === "all",
  });

  // Recent questions (last 5 user messages)
  const recentQuestions = recentMessages
    .filter((m) => m.role === "user")
    .slice(-5)
    .reverse();

  useEffect(() => {
    if (isOpen) {
      if (!wasOpenRef.current) {
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      setInput("");
      setResponse(null);
      setError(null);
      setScope(meetingId ? "this" : "all");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, meetingId]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeOverlay();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeOverlay, isOpen]);

  const handleSubmit = async (question?: string) => {
    const q = (question || input).trim();
    if (!q || isLoading) return;

    setIsLoading(true);
    setError(null);
    setResponse(null);

    try {
      let result: string;

      if (scope === "all") {
        // Use up to 15 most recent completed meetings
        const recentIds = allMeetings
          .filter((m) => m.status === "complete")
          .slice(0, 15)
          .map((m) => m.id);
        const contextIds =
          meetingId && !recentIds.includes(meetingId)
            ? [meetingId, ...recentIds].slice(0, 15)
            : recentIds;

        await ipc.createChatMessage(null, "user", q, JSON.stringify(contextIds));
        result = await ipc.chatWithMeetings(contextIds, q);
        await ipc.createChatMessage(null, "assistant", result, JSON.stringify(contextIds));
      } else {
        await ipc.createChatMessage(meetingId!, "user", q, JSON.stringify([meetingId]));
        result = await invoke<string>("chat_with_meeting", { meetingId, question: q });
        await ipc.createChatMessage(meetingId!, "assistant", result, JSON.stringify([meetingId]));
        queryClient.invalidateQueries({ queryKey: ["chat", meetingId] });
      }

      setResponse(result);
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (e) {
      console.error("AI query failed:", e);
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const suggestions =
    scope === "all"
      ? [
          "What decisions have we made across recent meetings?",
          "Summarize action items from the last few meetings",
          "What recurring topics keep coming up?",
        ]
      : [
          "What were the key decisions made?",
          "Summarize the action items",
          "What were the main topics discussed?",
        ];

  return (
    <div
      className="ask-ai-backdrop fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeOverlay();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Ask AI"
        className="ask-ai-content w-full max-w-lg bg-bg-secondary border border-border rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Scope toggle */}
        <div className="flex items-center gap-1 px-4 pt-3 pb-2">
          <Sparkles size={13} className="text-accent shrink-0 mr-1" />
          {meetingId && (
            <button
              type="button"
              onClick={() => { setScope("this"); setResponse(null); setError(null); }}
              aria-pressed={scope === "this"}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                scope === "this"
                  ? "bg-accent text-white"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
              }`}
            >
              This meeting
            </button>
          )}
          <button
            type="button"
            onClick={() => { setScope("all"); setResponse(null); setError(null); }}
            aria-pressed={scope === "all"}
            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
              scope === "all"
                ? "bg-accent text-white"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            All meetings
          </button>
        </div>

        {/* Input area */}
        <div className="flex items-center gap-3 px-4 py-3 border-t border-border">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            aria-label={scope === "all" ? "Ask across recent meetings" : "Ask about this meeting"}
            placeholder={
              scope === "all"
                ? "Ask across recent meetings…"
                : "Ask about this meeting…"
            }
            className="flex-1 bg-transparent text-sm text-text-primary focus:outline-none placeholder:text-text-muted"
            disabled={isLoading}
          />
          {input.trim() && !isLoading && (
            <div className="flex items-center gap-1 text-[10px] text-text-muted shrink-0">
              <CornerDownLeft size={10} />
              Enter
            </div>
          )}
          {isLoading && (
            <Loader2 size={14} className="animate-spin text-accent shrink-0" />
          )}
          <button
            type="button"
            onClick={closeOverlay}
            className="p-1 rounded text-text-muted hover:text-text-primary transition-colors shrink-0"
            title="Close Ask AI"
            aria-label="Close Ask AI"
          >
            <X size={14} />
          </button>
        </div>

        {/* Response area */}
        {(response || error || isLoading) && (
          <div className="px-4 py-3 max-h-[50vh] overflow-y-auto border-t border-border" aria-live="polite">
            {isLoading && !response && (
              <div className="flex items-center gap-2 text-sm text-text-muted py-2" role="status">
                <Loader2 size={14} className="animate-spin" />
                {scope === "all" ? "Searching recent meetings…" : "Thinking…"}
              </div>
            )}
            {error && (
              <div className="text-sm text-recording bg-recording/10 rounded-lg px-3 py-2" role="alert">
                {error}
              </div>
            )}
            {response && (
              <div className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                {response}
              </div>
            )}
          </div>
        )}

        {/* Recent questions (shown when no response, this-meeting scope only) */}
        {!response && !isLoading && !error && scope === "this" && recentQuestions.length > 0 && (
          <div className="px-4 py-2 border-t border-border">
            <span className="text-[10px] text-text-muted uppercase tracking-wider font-medium block mb-1.5">
              Recent questions
            </span>
            <div className="space-y-0.5">
              {recentQuestions.map((msg) => (
                <button
                  type="button"
                  key={msg.id}
                  onClick={() => {
                    setInput(msg.content);
                    handleSubmit(msg.content);
                  }}
                  className="w-full text-left px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors truncate"
                >
                  {msg.content}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Quick suggestions when empty */}
        {!response && !isLoading && !error && (scope === "all" || recentQuestions.length === 0) && (
          <div className="px-4 py-3 border-t border-border">
            <span className="text-[10px] text-text-muted uppercase tracking-wider font-medium block mb-2">
              Try asking
            </span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {suggestions.map((q) => (
                <button
                  type="button"
                  key={q}
                  onClick={() => {
                    setInput(q);
                    handleSubmit(q);
                  }}
                  className="min-h-10 w-full text-left px-2 py-1.5 text-xs leading-snug text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
