// src/lib/tiptap/ActionItemView.tsx
import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import { formatDeadline } from "./formatDeadline";

export function ActionItemView({ node, updateAttributes }: NodeViewProps) {
  const { task, assignee, deadline, done } = node.attrs as {
    task: string;
    assignee: string | null;
    deadline: string | null;
    done: boolean;
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
    </NodeViewWrapper>
  );
}
