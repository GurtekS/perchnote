import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

interface Props {
  items: string[];
  command: (props: { id: string }) => void;
}

export interface MentionListHandle {
  onKeyDown: (event: { event: KeyboardEvent }) => boolean;
}

export const MentionList = forwardRef<MentionListHandle, Props>(function MentionList(
  { items, command }, ref
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => setSelectedIndex(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        if (items[selectedIndex]) command({ id: items[selectedIndex] });
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="glass-float rounded-lg px-3 py-2 text-xs text-text-muted">
        No matches
      </div>
    );
  }

  return (
    <div className="glass-float rounded-lg overflow-hidden max-h-60 overflow-y-auto min-w-[180px]">
      {items.map((name, i) => (
        <button
          key={name}
          type="button"
          className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${
            i === selectedIndex ? "bg-accent/10 text-text-primary" : "text-text-secondary hover:bg-bg-hover"
          }`}
          onMouseDown={(e) => { e.preventDefault(); command({ id: name }); }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="w-5 h-5 rounded-full bg-accent text-white text-footnote font-semibold flex items-center justify-center">
            {name[0]?.toUpperCase() ?? "?"}
          </span>
          <span>{name}</span>
        </button>
      ))}
    </div>
  );
});
