// src/lib/tiptap/ActionItemView.tsx
import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import { formatDeadline } from "./formatDeadline";

export function ActionItemView({ node, updateAttributes }: NodeViewProps) {
  const { task, assignee, deadline, done, source_start_ms } = node.attrs as {
    task: string;
    assignee: string | null;
    deadline: string | null;
    done: boolean;
    source_start_ms: number | null;
  };

  const formatMs = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, "0")}`;
  };

  return (
    <NodeViewWrapper
      as="div"
      className={`tiptap-action-item ${done ? "is-done" : ""}`}
      data-action-item=""
    >
      <button
        type="button"
        className="tiptap-action-item__checkbox"
        aria-label={done ? "Mark not done" : "Mark done"}
        onClick={(e) => {
          e.preventDefault();
          updateAttributes({ done: !done });
        }}
        contentEditable={false}
      >
        {done && (
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
            <path
              d="M3 8l3 3 7-7"
              stroke="white"
              strokeWidth="2.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      <span className="tiptap-action-item__text">{task}</span>
      {assignee && (
        <span className="tiptap-action-item__person" contentEditable={false}>
          <span className="tiptap-action-item__avatar">{assignee[0]?.toUpperCase() ?? "?"}</span>
          {assignee}
        </span>
      )}
      {deadline && (
        <span className="tiptap-action-item__date" contentEditable={false}>
          {formatDeadline(deadline)}
        </span>
      )}
      {typeof source_start_ms === "number" && (
        <button
          type="button"
          contentEditable={false}
          className="tiptap-action-item__source"
          title="Hear this moment in the recording"
          onClick={(e) => {
            e.preventDefault();
            window.dispatchEvent(
              new CustomEvent("seek-audio", { detail: { ms: source_start_ms } }),
            );
          }}
        >
          ▸ {formatMs(source_start_ms)}
        </button>
      )}
    </NodeViewWrapper>
  );
}
