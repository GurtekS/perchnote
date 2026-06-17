/**
 * Enhancement state machine for MeetingView.
 *
 * Consolidates what used to be ~8 interlocking useState vars (isEnhanced,
 * preEnhanceContent, enhancedContent, isEnhancing, enhanceAnimText,
 * isAnimating, pendingEnhancedJson, notesDisplayMode, streamPreview) plus a
 * hasRestoredEnhance ref into ONE reducer with every transition in one place.
 *
 * Control state lives in `phase`:
 *
 *   idle ──start──▶ enhancing ──resolve──▶ animating ──animation-complete──▶ enhanced
 *     ▲                 │                      │                                │
 *     │           enhance-finished           undo                        start (re-enhance)
 *     │       (failure / stale settle)        │                                │
 *     └────────────────┴──────────────────────┴── undo ◀────────────────────────┘
 *
 * - `enhancing` remembers `wasEnhanced` so a failed RE-enhance falls back to
 *   the enhanced view, while a failed first enhance falls back to idle.
 * - The "is this meeting enhanced?" question (which decides whether the main
 *   editor shows AI notes and whether autosave writes generated_content or
 *   raw_content) is answered ONLY by the selectors below — never by scattered
 *   booleans.
 *
 * Meeting keying: the route component is REUSED across meeting ids (no
 * remount), and this machinery already shipped one cross-meeting note-leak
 * bug. Every action is therefore tagged with the meeting it was dispatched
 * for; actions tagged with a different meeting than the current state are
 * dropped (a stale enhance stream / settle from a meeting the user navigated
 * away from must not mutate the meeting on screen). Only `reset` re-keys the
 * state.
 */

export type NotesDisplayMode = "ai" | "original" | "split";

export type EnhancementPhase =
  /** No AI notes applied; the main editor edits raw notes. */
  | { name: "idle" }
  /**
   * An enhance run is in flight. `wasEnhanced` distinguishes a first enhance
   * (skeleton over raw notes; failure → idle) from a re-enhance (the enhanced
   * view stays interactive in original/split modes; failure → enhanced).
   * `streamText` accumulates the live `enhance-delta` summary preview.
   */
  | { name: "enhancing"; wasEnhanced: boolean; streamText: string }
  /**
   * The run resolved for THIS meeting; the typewriter overlay is playing
   * `animText`. `pendingJson` is injected into the editor on completion.
   */
  | { name: "animating"; animText: string; pendingJson: string }
  /** AI notes applied; `displayMode` picks ai / original / split panes. */
  | { name: "enhanced" };

export interface EnhancementState {
  /** The meeting this state belongs to. Only `reset` may change it. */
  meetingId: string;
  phase: EnhancementPhase;
  /**
   * Which pane the enhanced view shows. Only rendered while enhanced
   * (including animating and re-enhancing); forced back to "ai" whenever
   * enhancement is (re)applied or torn down.
   */
  displayMode: NotesDisplayMode;
  /** Snapshot of the user's raw notes — undo target + "My Notes" editor body. */
  preEnhanceContent?: string;
  /**
   * AI note body (TipTap JSON). Declarative source of truth so enhanced
   * notes survive editor remounts (navigate away and back).
   */
  enhancedContent?: string;
  /**
   * Latched once enhanced content has been applied or restored for this
   * meeting, so the note-loaded restore path runs at most once per meeting
   * (refetches afterwards only refresh the content fields). Also latched on
   * `start`: the enhance flow invalidates the note query mid-run, and that
   * refetch must not re-trigger the restore path.
   */
  hasRestored: boolean;
}

export type EnhancementAction =
  /** Meeting navigation — re-key and clear everything. */
  | { type: "reset" }
  /** An enhance run kicked off (first enhance or re-enhance). */
  | { type: "start" }
  /** Live summary text streamed while the model writes (`enhance-delta`). */
  | { type: "stream-delta"; text: string }
  /**
   * The run resolved FOR THIS MEETING. The caller (EnhanceButton) guards
   * with its startedFor check before invoking; the meeting tag on the action
   * is the second line of defense.
   */
  | { type: "resolve"; enhancedJson: string; rawMarkdown: string; rawContent?: string }
  /** The run settled (success or failure) — clears the in-flight phase. */
  | { type: "enhance-finished" }
  /** The typewriter overlay finished playing. */
  | { type: "animation-complete" }
  /** Undo Enhance — back to raw notes (generated_content stays in the DB). */
  | { type: "undo" }
  /** AI / My Notes / Split toggle. */
  | { type: "display-mode"; mode: NotesDisplayMode }
  /**
   * The note query (re)fetched with generated content present. First time
   * per meeting → flip to enhanced; afterwards → refresh the content fields
   * so external writers (e.g. the tasks view toggling an action item) are
   * not lost to the first cached snapshot.
   */
  | { type: "note-loaded"; generated: string; raw?: string }
  /** The "My Notes" editor autosaved — track the raw body for undo/split. */
  | { type: "original-saved"; json: string };

/** Every action carries the meeting it was dispatched for (see module docs). */
export type TaggedEnhancementAction = EnhancementAction & { meetingId: string };

export function createInitialEnhancementState(meetingId: string): EnhancementState {
  return {
    meetingId,
    phase: { name: "idle" },
    displayMode: "ai",
    preEnhanceContent: undefined,
    enhancedContent: undefined,
    hasRestored: false,
  };
}

export function enhancementReducer(
  state: EnhancementState,
  action: TaggedEnhancementAction,
): EnhancementState {
  if (action.type === "reset") {
    // Bail to the same reference when already pristine for this meeting so
    // the mount-time reset doesn't cause a render.
    if (
      state.meetingId === action.meetingId &&
      state.phase.name === "idle" &&
      state.displayMode === "ai" &&
      state.preEnhanceContent === undefined &&
      state.enhancedContent === undefined &&
      !state.hasRestored
    ) {
      return state;
    }
    return createInitialEnhancementState(action.meetingId);
  }

  // Stale action from a meeting that is no longer on screen — drop it.
  if (action.meetingId !== state.meetingId) return state;

  switch (action.type) {
    case "start": {
      // Double trigger (palette / pendingAutoEnhance while already running):
      // the per-meeting latch in lib/enhance.ts rejects the second run; keep
      // the in-flight phase (and its stream text) untouched.
      if (state.phase.name === "enhancing") return state;
      return {
        ...state,
        phase: { name: "enhancing", wasEnhanced: isEnhanced(state), streamText: "" },
        hasRestored: true,
      };
    }

    case "stream-delta": {
      if (state.phase.name !== "enhancing") return state;
      return {
        ...state,
        phase: { ...state.phase, streamText: state.phase.streamText + action.text },
      };
    }

    case "resolve": {
      return {
        ...state,
        phase: { name: "animating", animText: action.rawMarkdown, pendingJson: action.enhancedJson },
        displayMode: "ai",
        enhancedContent: action.enhancedJson,
        preEnhanceContent: action.rawContent,
        hasRestored: true,
      };
    }

    case "enhance-finished": {
      // Success path already moved on to animating via `resolve` — and a
      // stale settle from an abandoned run must not disturb it.
      if (state.phase.name !== "enhancing") return state;
      return {
        ...state,
        phase: state.phase.wasEnhanced ? { name: "enhanced" } : { name: "idle" },
      };
    }

    case "animation-complete": {
      if (state.phase.name !== "animating") return state;
      return { ...state, phase: { name: "enhanced" } };
    }

    case "undo": {
      // Undo while a RE-enhance is in flight: the run keeps going (the
      // skeleton shows until it lands), but the view drops back to raw notes
      // — matching the previous isEnhanced=false + isEnhancing=true combo.
      if (state.phase.name === "enhancing") {
        return {
          ...state,
          phase: { ...state.phase, wasEnhanced: false },
          displayMode: "ai",
          enhancedContent: undefined,
        };
      }
      // From enhanced — and from animating, where undo now also cancels the
      // overlay (previously the orphaned animation would later re-inject the
      // AI body into the raw-notes editor).
      return { ...state, phase: { name: "idle" }, displayMode: "ai", enhancedContent: undefined };
    }

    case "display-mode": {
      if (state.displayMode === action.mode) return state;
      return { ...state, displayMode: action.mode };
    }

    case "note-loaded": {
      // While the typewriter is playing, the refetch triggered by the
      // enhance write must not clobber the in-flight presentation.
      if (state.phase.name === "animating") return state;
      const restoring = !state.hasRestored;
      const next: EnhancementState = {
        ...state,
        preEnhanceContent: action.raw,
        enhancedContent: action.generated,
        hasRestored: true,
      };
      if (restoring) {
        next.phase = { name: "enhanced" };
        next.displayMode = "ai";
      } else if (
        state.preEnhanceContent === action.raw &&
        state.enhancedContent === action.generated
      ) {
        return state; // nothing changed — keep the reference stable
      }
      return next;
    }

    case "original-saved": {
      if (state.preEnhanceContent === action.json) return state;
      return { ...state, preEnhanceContent: action.json };
    }
  }
}

// ─── Selectors ────────────────────────────────────────────────────────────────
// Derived answers for the view layer. The editor's save path and content
// routing read these — never raw phase internals.

/** Is the enhanced view active (incl. animating in, and re-enhancing)? */
export function isEnhanced(state: EnhancementState): boolean {
  return (
    state.phase.name === "enhanced" ||
    state.phase.name === "animating" ||
    (state.phase.name === "enhancing" && state.phase.wasEnhanced)
  );
}

export function isEnhancing(state: EnhancementState): boolean {
  return state.phase.name === "enhancing";
}

export function isAnimating(state: EnhancementState): boolean {
  return state.phase.name === "animating";
}

/** Text for the typewriter overlay, or null when it isn't playing. */
export function animationText(state: EnhancementState): string | null {
  return state.phase.name === "animating" ? state.phase.animText : null;
}

/** TipTap JSON to inject into the editor when the animation completes. */
export function pendingEnhancedJson(state: EnhancementState): string | null {
  return state.phase.name === "animating" ? state.phase.pendingJson : null;
}

/** Live enhance stream preview ("" outside an in-flight run). */
export function streamPreview(state: EnhancementState): string {
  return state.phase.name === "enhancing" ? state.phase.streamText : "";
}

/**
 * Which note column the MAIN editor's autosave writes. The main editor holds
 * the AI notes whenever the meeting is enhanced (AI or Split view) and the
 * user's own notes otherwise; the "My Notes" editor always saves raw via its
 * own handler.
 */
export function saveTarget(state: EnhancementState): "generated_content" | "raw_content" {
  return isEnhanced(state) ? "generated_content" : "raw_content";
}
