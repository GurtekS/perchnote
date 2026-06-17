import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import { formatChipMs } from "./timestampChip";

export function TimestampChipView({ node }: NodeViewProps) {
  const ms = (node.attrs.ms as number) ?? 0;
  const label = formatChipMs(ms);

  return (
    <NodeViewWrapper as="span" data-timestamp-chip="" className="align-baseline">
      <button
        type="button"
        contentEditable={false}
        onClick={(e) => {
          e.preventDefault();
          // The transcript drawer owns the audio element; this event opens
          // it (MeetingView listener) and seeks — same path as the action
          // items' source chips.
          window.dispatchEvent(new CustomEvent("seek-audio", { detail: { ms } }));
        }}
        title={`Replay the recording at ${label}`}
        aria-label={`Replay the recording at ${label}`}
        className="mx-0.5 inline-flex items-center gap-0.5 rounded-md border border-accent/25 bg-accent/8 px-1.5 py-0 text-footnote font-medium leading-[1.4] text-accent transition-colors hover:bg-accent/15"
      >
        ⏱ {label}
      </button>
    </NodeViewWrapper>
  );
}
