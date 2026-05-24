import { RefObject } from "react";
import { NoteEditor, NoteEditorHandle } from "./NoteEditor";
import { EnhancingSkeleton } from "./EnhancingSkeleton";
import { EnhanceAnimationOverlay } from "./EnhanceAnimationOverlay";
import { AiNotesHeader } from "./AiNotesHeader";

interface Props {
  meetingId: string;
  editorRef: RefObject<NoteEditorHandle | null>;
  noteLoading: boolean;
  noteRawContent?: string;
  preEnhanceContent?: string;
  isEnhanced: boolean;
  notesDisplayMode: "ai" | "original";
  onNotesDisplayModeChange: (mode: "ai" | "original") => void;
  isEnhancing: boolean;
  isAnimating: boolean;
  enhanceAnimText: string | null;
  onUpdate: (json: string) => void;
  onOriginalUpdate: (json: string) => void;
  onAnimationComplete: () => void;
  aiTags?: string[];
}

export function NotesSurface(props: Props) {
  const {
    meetingId, editorRef,
    noteLoading, noteRawContent, preEnhanceContent,
    isEnhanced, notesDisplayMode, onNotesDisplayModeChange,
    isEnhancing, isAnimating, enhanceAnimText,
    onUpdate, onOriginalUpdate, onAnimationComplete,
  } = props;

  return (
    <section className="pb-8" aria-label="Meeting notes">
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
                onNotesDisplayModeChange(notesDisplayMode === "ai" ? "original" : "ai");
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
          </div>
          {notesDisplayMode === "original" && (
            <span className="text-[11px] text-text-muted">Editing original</span>
          )}
        </div>
      )}

      {isEnhanced && notesDisplayMode === "original" ? (
        <NoteEditor
          key={`${meetingId}-original`}
          content={preEnhanceContent}
          onUpdate={onOriginalUpdate}
          notepadMode
        />
      ) : isEnhancing || noteLoading ? (
        <EnhancingSkeleton loading={!isEnhancing} />
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
              content={noteRawContent}
              onUpdate={onUpdate}
              placeholder="Jot your notes here during the meeting..."
              notepadMode
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
    </section>
  );
}
