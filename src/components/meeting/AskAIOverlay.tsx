import { useState, useRef, useEffect, useCallback, Fragment } from "react";
import { Loader2, Sparkles, X, CornerDownLeft } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { ipc, type ChatCitation } from "../../lib/ipc";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useUIStore } from "../../stores/uiStore";
import { FILTER_HINT } from "../../lib/searchFilterHints";

interface AskAIOverlayProps {
  meetingId?: string | null;
  isOpen: boolean;
  onClose: () => void;
}

type Scope = "this" | "all";

function formatCiteTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function AskAIOverlay({ meetingId, isOpen, onClose }: AskAIOverlayProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  // Sources behind the latest "all meetings" answer; [n] tokens in the
  // answer become chips targeting these. Session-only (plan v8 A5).
  const [citations, setCitations] = useState<ChatCitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>(meetingId ? "this" : "all");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Stale-response guard: every question takes a token; only the answer
  // whose token is still current may touch state. Scope switches, reopens,
  // and newer questions bump the counter, orphaning anything in flight — a
  // late "all" answer can never render under the "this" tab (or vice versa).
  const requestSeq = useRef(0);

  const closeOverlay = useCallback(() => {
    onClose();
  }, [onClose]);

  // Jump to the cited moment — same two-step handoff as CommandPalette (A3):
  // park the pending seek (keyed to the cited meeting) BEFORE navigating so
  // the async-mounting MeetingView picks it up, then dispatch seek-audio
  // once navigation has resolved.
  const openCitation = useCallback(
    async (cite: ChatCitation) => {
      const current = matchRoute({ to: "/meeting/$id", fuzzy: true }) as
        | { id?: string }
        | false;
      const alreadyThere = !!current && current.id === cite.meeting_id;
      if (!alreadyThere) {
        useUIStore.getState().setPendingSeek(cite.meeting_id, cite.start_ms);
        await navigate({ to: "/meeting/$id", params: { id: cite.meeting_id } });
      }
      window.dispatchEvent(new CustomEvent("seek-audio", { detail: { ms: cite.start_ms } }));
      onClose();
    },
    [matchRoute, navigate, onClose]
  );

  // Render [n] tokens as citation chips when n maps to a returned source;
  // hallucinated numbers stay plain text.
  const renderAnswer = (text: string) =>
    text.split(/(\[\d+\])/g).map((part, i) => {
      const token = /^\[(\d+)\]$/.exec(part);
      const cite = token
        ? citations.find((c) => c.n === Number(token[1]))
        : undefined;
      if (!cite) return <Fragment key={i}>{part}</Fragment>;
      return (
        <button
          type="button"
          key={i}
          onClick={() => openCitation(cite)}
          className="mx-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-accent/15 px-1 align-super text-[10px] font-semibold leading-4 text-accent transition-colors hover:bg-accent hover:text-white"
          title={`${cite.meeting_title} · ${formatCiteTime(cite.start_ms)}`}
          aria-label={`Open source ${cite.n}: ${cite.meeting_title}`}
        >
          {cite.n}
        </button>
      );
    });

  useFocusTrap(isOpen, dialogRef, closeOverlay);

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
      requestSeq.current++; // orphan any question still in flight from before
      setInput("");
      setIsLoading(false);
      setResponse(null);
      setCitations([]);
      setError(null);
      setScope(meetingId ? "this" : "all");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, meetingId]);

  // Belt and suspenders: the buttons are also disabled while a question is
  // in flight, but switching always orphans the in-flight token so a late
  // answer from the other scope can never render here.
  const switchScope = (next: Scope) => {
    requestSeq.current++;
    setIsLoading(false);
    setScope(next);
    setResponse(null);
    setCitations([]);
    setError(null);
  };

  const handleSubmit = async (question?: string) => {
    const q = (question || input).trim();
    if (!q || isLoading) return;

    const token = ++requestSeq.current;
    setIsLoading(true);
    setError(null);
    setResponse(null);
    setCitations([]);

    try {
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
        const result = await ipc.chatWithMeetings(contextIds, q);
        if (token !== requestSeq.current) return; // stale — scope switched or overlay reset
        setResponse(result.answer);
        setCitations(result.citations);
        // History write happens after the answer is shown — a failed write
        // must not discard a response the user already paid for. Only the
        // answer text persists; citations are session-only.
        try {
          await ipc.createChatMessage(null, "assistant", result.answer, JSON.stringify(contextIds));
        } catch (err) {
          console.error("Failed to save chat history:", err);
        }
      } else {
        await ipc.createChatMessage(meetingId!, "user", q, JSON.stringify([meetingId]));
        const result = await invoke<string>("chat_with_meeting", { meetingId, question: q });
        if (token !== requestSeq.current) return; // stale — scope switched or overlay reset
        setResponse(result);
        try {
          await ipc.createChatMessage(meetingId!, "assistant", result, JSON.stringify([meetingId]));
        } catch (err) {
          console.error("Failed to save chat history:", err);
        } finally {
          queryClient.invalidateQueries({ queryKey: ["chat", meetingId] });
        }
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (e) {
      console.error("AI query failed:", e);
      if (token !== requestSeq.current) return;
      setError(String(e));
    } finally {
      // Whoever orphaned this request owns the loading flag now.
      if (token === requestSeq.current) setIsLoading(false);
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
        className="ask-ai-content w-full max-w-lg glass-float rounded-xl overflow-hidden"
      >
        {/* Scope toggle */}
        <div className="flex items-center gap-1 px-4 pt-3 pb-2">
          <Sparkles size={13} className="text-accent shrink-0 mr-1" />
          {meetingId && (
            <button
              type="button"
              onClick={() => switchScope("this")}
              disabled={isLoading}
              aria-pressed={scope === "this"}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 ${
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
            onClick={() => switchScope("all")}
            disabled={isLoading}
            aria-pressed={scope === "all"}
            className={`text-xs px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 ${
              scope === "all"
                ? "bg-accent text-white"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            All meetings
          </button>
          {scope === "all" && (
            <span className="text-footnote text-text-muted ml-1.5">
              finds the most relevant meetings for your question
            </span>
          )}
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
            <div className="flex items-center gap-1 text-footnote text-text-muted shrink-0">
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

        {/* All-meetings retrieval honors the palette's filter grammar
            server-side (deep review P3) — teach it where the question is
            typed, styled like the palette's footer hint. */}
        {scope === "all" && (
          <div className="flex items-center px-4 pb-2 text-footnote text-text-muted">
            <span className="truncate font-mono" title={FILTER_HINT}>
              Filters work here: speaker: folder: before: after:
            </span>
          </div>
        )}

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
                {citations.length > 0 ? renderAnswer(response) : response}
              </div>
            )}
          </div>
        )}

        {/* Recent questions (shown when no response, this-meeting scope only) */}
        {!response && !isLoading && !error && scope === "this" && recentQuestions.length > 0 && (
          <div className="px-4 py-2 border-t border-border">
            <span className="text-footnote text-text-muted uppercase tracking-wider font-medium block mb-1.5">
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
            <span className="text-footnote text-text-muted uppercase tracking-wider font-medium block mb-2">
              Try asking
            </span>
            <div className="flex flex-col gap-1">
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
