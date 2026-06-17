import { describe, expect, it } from "vitest";
import {
  createInitialEnhancementState,
  enhancementReducer,
  isAnimating,
  isEnhanced,
  isEnhancing,
  animationText,
  pendingEnhancedJson,
  streamPreview,
  saveTarget,
  type EnhancementAction,
  type EnhancementState,
} from "../../components/meeting/enhancementMachine";

const RAW = '{"type":"doc","raw":true}';
const AI = '{"type":"doc","ai":true}';

/** Dispatch a sequence of actions for meeting m1 (unless overridden). */
function run(actions: Array<EnhancementAction & { meetingId?: string }>, from?: EnhancementState) {
  return actions.reduce(
    (state, { meetingId = "m1", ...action }) =>
      enhancementReducer(state, { ...action, meetingId } as Parameters<typeof enhancementReducer>[1]),
    from ?? createInitialEnhancementState("m1"),
  );
}

describe("enhancementMachine", () => {
  it("starts idle: raw notes shown, autosave targets raw_content", () => {
    const s = createInitialEnhancementState("m1");
    expect(isEnhanced(s)).toBe(false);
    expect(isEnhancing(s)).toBe(false);
    expect(isAnimating(s)).toBe(false);
    expect(saveTarget(s)).toBe("raw_content");
    expect(s.displayMode).toBe("ai");
  });

  it("first enhance: start → stream → resolve → animation-complete → enhanced", () => {
    let s = run([{ type: "start" }]);
    expect(isEnhancing(s)).toBe(true);
    expect(isEnhanced(s)).toBe(false); // first enhance: skeleton over raw notes
    expect(saveTarget(s)).toBe("raw_content");

    s = run([{ type: "stream-delta", text: "Hello " }, { type: "stream-delta", text: "world" }], s);
    expect(streamPreview(s)).toBe("Hello world");

    s = run([{ type: "resolve", enhancedJson: AI, rawMarkdown: "md", rawContent: RAW }], s);
    expect(isAnimating(s)).toBe(true);
    expect(isEnhanced(s)).toBe(true); // animating counts as enhanced (save target flips)
    expect(animationText(s)).toBe("md");
    expect(pendingEnhancedJson(s)).toBe(AI);
    expect(s.enhancedContent).toBe(AI);
    expect(s.preEnhanceContent).toBe(RAW);
    expect(s.displayMode).toBe("ai");
    expect(saveTarget(s)).toBe("generated_content");
    expect(streamPreview(s)).toBe(""); // stream preview is gone once resolved

    // The settle callback fires after resolve — must not disturb animating.
    s = run([{ type: "enhance-finished" }], s);
    expect(isAnimating(s)).toBe(true);

    s = run([{ type: "animation-complete" }], s);
    expect(s.phase.name).toBe("enhanced");
    expect(isEnhanced(s)).toBe(true);
    expect(animationText(s)).toBeNull();
    expect(pendingEnhancedJson(s)).toBeNull();
  });

  it("failed first enhance settles back to idle", () => {
    const s = run([{ type: "start" }, { type: "enhance-finished" }]);
    expect(s.phase.name).toBe("idle");
    expect(isEnhanced(s)).toBe(false);
    expect(saveTarget(s)).toBe("raw_content");
  });

  it("re-enhance stays enhanced while in flight; failure falls back to enhanced view", () => {
    const enhanced = run([
      { type: "start" },
      { type: "resolve", enhancedJson: AI, rawMarkdown: "md", rawContent: RAW },
      { type: "animation-complete" },
      { type: "display-mode", mode: "split" },
    ]);

    const inFlight = run([{ type: "start" }], enhanced);
    expect(isEnhancing(inFlight)).toBe(true);
    expect(isEnhanced(inFlight)).toBe(true); // autosave keeps targeting generated_content
    expect(saveTarget(inFlight)).toBe("generated_content");
    expect(inFlight.displayMode).toBe("split"); // split/original panes stay up during re-run

    const failed = run([{ type: "enhance-finished" }], inFlight);
    expect(failed.phase.name).toBe("enhanced");
    expect(failed.displayMode).toBe("split");
    expect(failed.enhancedContent).toBe(AI);
  });

  it("undo returns to idle, clears the AI body, keeps the raw snapshot for the editor", () => {
    const s = run([
      { type: "start" },
      { type: "resolve", enhancedJson: AI, rawMarkdown: "md", rawContent: RAW },
      { type: "animation-complete" },
      { type: "undo" },
    ]);
    expect(s.phase.name).toBe("idle");
    expect(s.enhancedContent).toBeUndefined();
    expect(s.preEnhanceContent).toBe(RAW);
    expect(s.displayMode).toBe("ai");
    expect(saveTarget(s)).toBe("raw_content");
  });

  it("undo mid-animation cancels the overlay (no orphaned animation can re-inject AI notes)", () => {
    const s = run([
      { type: "start" },
      { type: "resolve", enhancedJson: AI, rawMarkdown: "md", rawContent: RAW },
      { type: "undo" },
    ]);
    expect(isAnimating(s)).toBe(false);
    expect(pendingEnhancedJson(s)).toBeNull();
    expect(s.phase.name).toBe("idle");
  });

  it("undo during a re-enhance keeps the run in flight but drops to raw notes", () => {
    const s = run([
      { type: "start" },
      { type: "resolve", enhancedJson: AI, rawMarkdown: "md", rawContent: RAW },
      { type: "animation-complete" },
      { type: "start" },
      { type: "undo" },
    ]);
    expect(isEnhancing(s)).toBe(true); // skeleton keeps showing until the run lands
    expect(isEnhanced(s)).toBe(false);
    expect(saveTarget(s)).toBe("raw_content");
  });

  it("note-loaded restores the enhanced view exactly once per meeting", () => {
    const restored = run([{ type: "note-loaded", generated: AI, raw: RAW }]);
    expect(restored.phase.name).toBe("enhanced");
    expect(restored.displayMode).toBe("ai");
    expect(restored.enhancedContent).toBe(AI);
    expect(restored.preEnhanceContent).toBe(RAW);
    expect(restored.hasRestored).toBe(true);

    // A later refetch (external writer, e.g. tasks view) refreshes the
    // content fields without flipping any phase/mode.
    const afterUndo = run([{ type: "undo" }], restored);
    const refetched = run([{ type: "note-loaded", generated: AI, raw: RAW }], afterUndo);
    expect(refetched.phase.name).toBe("idle"); // undo sticks — no re-restore
    expect(refetched.enhancedContent).toBe(AI);

    const updated = run([{ type: "note-loaded", generated: AI.replace("true", "false"), raw: RAW }], restored);
    expect(updated.phase.name).toBe("enhanced");
    expect(updated.enhancedContent).toBe(AI.replace("true", "false"));
  });

  it("note-loaded during enhancing only refreshes content (start latched hasRestored)", () => {
    const s = run([{ type: "start" }, { type: "note-loaded", generated: AI, raw: RAW }]);
    expect(isEnhancing(s)).toBe(true); // still the skeleton, NOT flipped to enhanced
    expect(s.enhancedContent).toBe(AI);
  });

  it("note-loaded mid-animation is ignored so the refetch can't clobber the overlay", () => {
    const animating = run([
      { type: "start" },
      { type: "resolve", enhancedJson: AI, rawMarkdown: "md", rawContent: RAW },
    ]);
    const s = run([{ type: "note-loaded", generated: "other", raw: "other-raw" }], animating);
    expect(s).toBe(animating);
  });

  it("original-saved tracks the raw body for undo and the My Notes pane", () => {
    const s = run([{ type: "original-saved", json: RAW }]);
    expect(s.preEnhanceContent).toBe(RAW);
  });

  it("drops actions tagged for a different meeting (stale stream/settle after navigation)", () => {
    const enhancing = run([{ type: "start" }]);
    const afterStale = run(
      [
        { type: "stream-delta", text: "leak", meetingId: "m2" },
        { type: "resolve", enhancedJson: AI, rawMarkdown: "md", meetingId: "m2" },
        { type: "undo", meetingId: "m2" },
      ],
      enhancing,
    );
    expect(afterStale).toBe(enhancing);
  });

  it("reset re-keys to the new meeting and clears everything", () => {
    const enhanced = run([
      { type: "start" },
      { type: "resolve", enhancedJson: AI, rawMarkdown: "md", rawContent: RAW },
      { type: "animation-complete" },
    ]);
    const s = run([{ type: "reset", meetingId: "m2" }], enhanced);
    expect(s).toEqual(createInitialEnhancementState("m2"));

    // Pristine reset for the same meeting keeps the reference (no render churn).
    const pristine = createInitialEnhancementState("m1");
    expect(run([{ type: "reset" }], pristine)).toBe(pristine);
  });

  it("duplicate start while a run is in flight is a no-op (lib/enhance.ts latch rejects the run)", () => {
    const first = run([{ type: "start" }, { type: "stream-delta", text: "abc" }]);
    const second = run([{ type: "start" }], first);
    expect(second).toBe(first);
    expect(streamPreview(second)).toBe("abc");
  });

  it("display-mode changes only repaint when the mode actually changed", () => {
    const enhanced = run([{ type: "note-loaded", generated: AI, raw: RAW }]);
    expect(run([{ type: "display-mode", mode: "ai" }], enhanced)).toBe(enhanced);
    const split = run([{ type: "display-mode", mode: "split" }], enhanced);
    expect(split.displayMode).toBe("split");
    expect(isEnhanced(split)).toBe(true);
  });
});
