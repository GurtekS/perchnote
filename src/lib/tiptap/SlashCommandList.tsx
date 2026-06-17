import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { SlashCommandItem } from "./slashCommandItems";

interface Props {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
}

export interface SlashCommandListHandle {
  onKeyDown: (event: { event: KeyboardEvent }) => boolean;
}

export const SlashCommandList = forwardRef<SlashCommandListHandle, Props>(function SlashCommandList(
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
        if (items[selectedIndex]) command(items[selectedIndex]);
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
    <div className="glass-float rounded-lg overflow-hidden max-h-72 overflow-y-auto min-w-[220px]">
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${
            i === selectedIndex ? "bg-accent/10 text-text-primary" : "text-text-secondary hover:bg-bg-hover"
          }`}
          onMouseDown={(e) => { e.preventDefault(); command(item); }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="text-sm font-medium">{item.label}</span>
          <span className="text-caption text-text-muted">{item.description}</span>
        </button>
      ))}
    </div>
  );
});
