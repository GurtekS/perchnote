import { useEffect, useRef } from "react";

/**
 * The Escape dismissal ladder. Every layered surface (dialog, palette,
 * context menu, drawer) registers while open; Escape closes ONLY the most
 * recently opened layer. Without this, every window-level Escape listener
 * fired at once — closing the shortcuts overlay also wiped the meeting-list
 * selection and search behind it.
 *
 * The listener runs in the capture phase and stops the event when it
 * handles Escape, so background listeners (list-selection clearing, inline
 * edits) never see an Escape that was meant for an overlay. When nothing
 * is registered the listener stands down entirely.
 */
type CloseFn = () => void;

const stack: CloseFn[] = [];

function handleKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stack[stack.length - 1]();
}

export function pushOverlay(close: CloseFn): () => void {
  if (stack.length === 0) {
    window.addEventListener("keydown", handleKeyDown, true);
  }
  stack.push(close);
  return () => {
    const i = stack.lastIndexOf(close);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0) {
      window.removeEventListener("keydown", handleKeyDown, true);
    }
  };
}

/** Register `close` on the dismissal ladder while `active`. */
export function useOverlay(active: boolean, close: CloseFn) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    return pushOverlay(() => closeRef.current());
  }, [active]);
}
