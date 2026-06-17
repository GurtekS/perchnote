import { RefObject, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Columns2, History, Repeat } from "lucide-react";
import { ipc, Note } from "../../lib/ipc";
import { scheduleMirror } from "../../lib/mirrorLifecycle";
import { NoteEditor, NoteEditorHandle } from "./NoteEditor";
import { EnhancingSkeleton } from "./EnhancingSkeleton";
import { EnhanceAnimationOverlay } from "./EnhanceAnimationOverlay";
import { AiNotesHeader } from "./AiNotesHeader";
import { NotesReceipt } from "./NotesReceipt";
import { RecipeAutoRunCard } from "./RecipeAutoRunCard";

interface Props {
  meetingId: string;
  editorRef: RefObject<NoteEditorHandle | null>;
  noteLoading: boolean;
  noteRawContent?: string;
  /** Full note row, for the enhance receipt (plan v10 #2). Optional — the
   *  receipt simply doesn't render when absent. */
  note?: Note | null;
  /** Live summary text streamed while enhancement runs (plan rank 1). */
  streamPreview?: string;
  preEnhanceContent?: string;
  /** AI-enhanced note body (TipTap JSON). Shown in the main editor when
   *  enhanced + AI mode — this is the declarative source of truth so the
   *  enhanced notes survive remounts (e.g. navigating away and back). */
  enhancedContent?: string;
  isEnhanced: boolean;
  notesDisplayMode: "ai" | "original" | "split";
  onNotesDisplayModeChange: (mode: "ai" | "original" | "split") => void;
  isEnhancing: boolean;
  isAnimating: boolean;
  enhanceAnimText: string | null;
  onUpdate: (json: string) => void;
  onOriginalUpdate: (json: string) => void;
  onAnimationComplete: () => void;
  aiTags?: string[];
  /** Recording quiet mode: chrome retreats so nothing competes with capture. */
  isRecording?: boolean;
}

/** Shown while recording — states the Granola-style contract out loud:
 *  fragments are enough, structure comes free, Enhance fills in the rest. */
const RECORDING_PLACEHOLDER =
  "Jot fragments. They're enough. [] + space for a task, ⌘D marks this moment. Enhance fills in the rest.";

export function NotesSurface(props: Props) {
  const {
    meetingId, editorRef,
    noteLoading, noteRawContent, preEnhanceContent, enhancedContent, streamPreview,
    isEnhanced, notesDisplayMode, onNotesDisplayModeChange,
    isEnhancing, isAnimating, enhanceAnimText,
    onUpdate, onOriginalUpdate, onAnimationComplete,
    isRecording = false,
  } = props;

  // The main editor's declarative content. When enhanced + AI mode it must be
  // the enhanced body, otherwise the NoteEditor content-sync effect re-applies
  // raw_content on remount and silently wipes the AI notes. Falls back to raw
  // if the enhanced body somehow hasn't loaded yet.
  const mainEditorContent =
    isEnhanced && notesDisplayMode === "ai"
      ? enhancedContent ?? noteRawContent
      : noteRawContent;

  // Open loops (plan rank 13): unfinished items from prior meetings with
  // these attendees, surfaced until this meeting has AI notes of its own.
  const navigate = useNavigate();
  const { data: openLoops = [] } = useQuery({
    queryKey: ["open-loops", meetingId],
    queryFn: () => ipc.openLoopsForMeeting(meetingId),
    enabled: !isEnhanced && !isEnhancing,
    staleTime: 60_000,
  });

  // "Last time" (plan v2 rank 11): the previous meeting in this recurring
  // series — its summary and unfinished items, shown until notes exist here.
  const { data: lastTime } = useQuery({
    queryKey: ["last-time", meetingId],
    queryFn: () => ipc.lastTimeInSeries(meetingId),
    enabled: !isEnhanced && !isEnhancing,
    staleTime: 60_000,
  });
  const queryClient = useQueryClient();
  const [carriedOver, setCarriedOver] = useState(false);
  // The surface stays mounted across meeting switches — re-arm the button.
  useEffect(() => setCarriedOver(false), [meetingId]);

  // Carry-forward (plan v3 rank 3): thread last time's unfinished items into
  // THIS note as a checklist agenda block — deliberately NOT actionItem
  // nodes, so the originals stay the single tracked copies in /tasks.
  const handleCarryOver = async () => {
    if (!lastTime || lastTime.open_items.length === 0) return;
    try {
      const note = await ipc.getOrCreateNote(meetingId);
      let doc: { type: string; content: unknown[] };
      try {
        const parsed = JSON.parse(note.raw_content ?? "");
        doc = parsed?.type === "doc" ? { content: [], ...parsed } : { type: "doc", content: [] };
        doc.content = doc.content ?? [];
      } catch {
        doc = { type: "doc", content: [] };
      }
      doc.content.push(
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: `From last time (${lastTime.title})` }],
        },
        {
          type: "taskList",
          content: lastTime.open_items.map((item) => ({
            type: "taskItem",
            attrs: { checked: false },
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: item.assignee ? `${item.task} (${item.assignee})` : item.task,
                  },
                ],
              },
            ],
          })),
        },
      );
      await ipc.updateNoteRawContent(note.id, JSON.stringify(doc));
      scheduleMirror(meetingId); // a note save like any other (plan v8 B2)
      queryClient.invalidateQueries({ queryKey: ["note", meetingId] });
      setCarriedOver(true);
    } catch (e) {
      window.console.error("carry-over failed:", e);
    }
  };

  // LEGACY: ⌘-click a plain-text "⏱ m:ss" mark to replay it. New ⌘D marks
  // are timestampChip nodes that replay on plain click (plan v7 capture 6);
  // this stays only so marks made before the chip existed keep working.
  const handleMetaClick = (e: React.MouseEvent) => {
    if (!e.metaKey) return;
    const caret = (
      document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      }
    ).caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = caret?.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? "";
    const re = /⏱ (\d+):(\d{2})/g;
    let best: { ms: number; dist: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const dist = Math.abs((caret?.startOffset ?? 0) - m.index);
      const ms = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
      if (!best || dist < best.dist) best = { ms, dist };
    }
    if (best) {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent("seek-audio", { detail: { ms: best.ms } }));
    }
  };

  return (
    <section className="pb-8" aria-label="Meeting notes" onClickCapture={handleMetaClick}>
      <RecipeAutoRunCard meetingId={meetingId} />
      {!isEnhanced && !isEnhancing && openLoops.length > 0 && (
        <div className="card mb-4 p-3 animate-fade-in">
          <p className="section-label mb-2 flex items-center gap-1.5">
            <History size={11} />
            Open loops from past meetings
          </p>
          <ul className="space-y-1 list-none p-0 m-0">
            {openLoops.slice(0, 5).map((loop) => (
              <li key={`${loop.note_id}:${loop.source}:${loop.index}`}>
                <button
                  type="button"
                  onClick={() =>
                    navigate({ to: "/meeting/$id", params: { id: loop.meeting_id } })
                  }
                  className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left hover:bg-bg-hover"
                  title={`From “${loop.meeting_title}” (open that meeting)`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">
                    {loop.task}
                  </span>
                  <span className="text-footnote shrink-0 max-w-[140px] truncate text-text-muted">
                    {loop.meeting_title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {openLoops.length > 5 && (
            <p className="text-footnote mt-1.5 text-text-muted">
              +{openLoops.length - 5} more in Tasks (⌘2)
            </p>
          )}
        </div>
      )}
      {!isEnhanced && !isEnhancing && lastTime && (
        <div className="card mb-4 p-3 animate-fade-in">
          <p className="section-label mb-2 flex items-center gap-1.5">
            <Repeat size={11} />
            Last time: {lastTime.title}
            <span className="font-normal normal-case tracking-normal text-text-muted">
              {lastTime.date.slice(0, 10)}
            </span>
          </p>
          {lastTime.summary && (
            <p className="m-0 text-sm leading-relaxed text-text-secondary">
              {lastTime.summary.length > 280
                ? `${lastTime.summary.slice(0, 280).trimEnd()}…`
                : lastTime.summary}
            </p>
          )}
          {lastTime.open_items.length > 0 && (
            <ul className="mt-2 space-y-0.5 list-none p-0 m-0">
              {lastTime.open_items.slice(0, 3).map((item) => (
                <li
                  key={`${item.note_id}:${item.source}:${item.index}`}
                  className="flex items-baseline gap-1.5 text-sm text-text-secondary"
                >
                  <span aria-hidden className="text-text-muted">○</span>
                  <span className="min-w-0 flex-1 truncate">{item.task}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            {lastTime.open_items.length > 0 && (
              <button
                type="button"
                onClick={handleCarryOver}
                disabled={carriedOver}
                className="text-caption rounded-md px-1.5 py-0.5 -ml-1.5 text-accent hover:bg-bg-hover disabled:opacity-60 disabled:hover:bg-transparent"
              >
                {carriedOver
                  ? "✓ Added to your notes"
                  : `Carry over ${lastTime.open_items.length} open item${lastTime.open_items.length === 1 ? "" : "s"}`}
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                navigate({ to: "/meeting/$id", params: { id: lastTime.meeting_id } })
              }
              className="text-caption rounded-md px-1.5 py-0.5 text-accent hover:bg-bg-hover"
            >
              Open last meeting →
            </button>
          </div>
        </div>
      )}
      {isEnhanced && (props.aiTags?.length ?? 0) > 0 && (
        <AiNotesHeader tags={props.aiTags ?? []} />
      )}
      {isEnhanced && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div
            className="view-toggle-pill"
            role="group"
            aria-label="Notes display mode"
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const order: Array<"ai" | "original" | "split"> = ["ai", "original", "split"];
                const dir = e.key === "ArrowRight" ? 1 : -1;
                const i = order.indexOf(notesDisplayMode);
                onNotesDisplayModeChange(order[(i + dir + order.length) % order.length]);
              }
            }}
          >
            <button
              type="button"
              onClick={() => onNotesDisplayModeChange("ai")}
              className={notesDisplayMode === "ai" ? "active" : ""}
              aria-pressed={notesDisplayMode === "ai"}
            >
              AI Notes
            </button>
            <button
              type="button"
              onClick={() => onNotesDisplayModeChange("original")}
              className={notesDisplayMode === "original" ? "active" : ""}
              aria-pressed={notesDisplayMode === "original"}
            >
              My Notes
            </button>
            <button
              type="button"
              onClick={() => onNotesDisplayModeChange("split")}
              className={`flex items-center gap-1 ${notesDisplayMode === "split" ? "active" : ""}`}
              aria-pressed={notesDisplayMode === "split"}
              title="Show My Notes and AI Notes side by side"
            >
              <Columns2 size={12} />
              Split
            </button>
          </div>
          {notesDisplayMode === "original" && (
            <span className="text-caption text-text-muted">Editing original</span>
          )}
        </div>
      )}

      {isEnhanced && notesDisplayMode === "split" ? (
        <div className="grid grid-cols-2 gap-4">
          {/* My Notes — saves to raw_content */}
          <div className="min-w-0">
            <div className="mb-1.5 text-caption font-medium uppercase tracking-wider text-text-muted">
              My Notes
            </div>
            <NoteEditor
              key={`${meetingId}-split-original`}
              meetingId={meetingId}
              content={preEnhanceContent}
              onUpdate={onOriginalUpdate}
              notepadMode
            />
          </div>
          {/* AI Notes — saves to generated_content */}
          <div className="min-w-0 border-l border-border pl-4">
            <div className="mb-1.5 text-caption font-medium uppercase tracking-wider text-text-muted">
              AI Notes
            </div>
            <div className="ai-enhanced-text">
              <NoteEditor
                key={`${meetingId}-split-ai`}
                ref={editorRef}
                meetingId={meetingId}
                content={enhancedContent ?? noteRawContent}
                onUpdate={onUpdate}
                notepadMode
                // Split showed TWO full toolbars side by side (visual
                // review); the AI pane is read-mostly — My Notes keeps it.
                showToolbar={false}
              />
            </div>
          </div>
        </div>
      ) : isEnhanced && notesDisplayMode === "original" ? (
        <NoteEditor
          key={`${meetingId}-original`}
          meetingId={meetingId}
          content={preEnhanceContent}
          onUpdate={onOriginalUpdate}
          notepadMode
        />
      ) : isEnhancing || noteLoading ? (
        streamPreview ? (
          <div className="ai-enhanced-text animate-fade-in px-1 py-2">
            <p className="section-label mb-2">Summary, writing live…</p>
            <p className="whitespace-pre-wrap text-sm text-text-secondary">
              {streamPreview}
              <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-accent/70" />
            </p>
          </div>
        ) : (
          <EnhancingSkeleton loading={!isEnhancing} />
        )
      ) : (
        <div className={`relative ${isAnimating ? "pointer-events-none" : ""}`}>
          <div className={
            isAnimating
              ? "opacity-20 blur-[1px] transition-all duration-500"
              : isEnhanced
              ? "ai-enhanced-text"
              : ""
          }>
            <NoteEditor
              key={meetingId}
              ref={editorRef}
              meetingId={meetingId}
              content={mainEditorContent}
              onUpdate={onUpdate}
              placeholder={isRecording ? RECORDING_PLACEHOLDER : undefined}
              notepadMode
              // AI notes are read-mostly — the formatting bar shows in
              // editing contexts (My Notes, split, recording, un-enhanced)
              // and steps back when displaying generated notes (UI review).
              showToolbar={!isEnhanced || notesDisplayMode !== "ai" ? undefined : false}
            />
          </div>
          {isAnimating && enhanceAnimText && (
            <EnhanceAnimationOverlay
              text={enhanceAnimText}
              onComplete={onAnimationComplete}
            />
          )}
        </div>
      )}

      {/* Enhance receipt (plan v10 #2) — quiet provenance line under the AI
          notes. Renders nothing for notes without receipts (pre-18, no-AI). */}
      {isEnhanced && !isEnhancing && !isAnimating && notesDisplayMode !== "original" && (
        <NotesReceipt meetingId={meetingId} note={props.note} />
      )}
    </section>
  );
}
