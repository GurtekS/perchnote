import { useEffect, type RefObject } from "react";

/**
 * Roving tabindex (WAI-APG): the whole list is ONE tab stop; Arrow keys,
 * Home, and End move between items, and the last-visited item keeps the
 * tab stop so Tab leaves and re-enters where the user was.
 *
 * DOM-driven so list components don't need per-item focus state: items are
 * whatever currently matches `itemSelector` inside the container, and a
 * MutationObserver re-normalizes tabindexes as rows mount/unmount.
 */
export function useRovingFocus(
  containerRef: RefObject<HTMLElement | null>,
  itemSelector: string,
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const items = () =>
      Array.from(container.querySelectorAll<HTMLElement>(itemSelector));

    const setActive = (el: HTMLElement) => {
      for (const item of items()) item.tabIndex = item === el ? 0 : -1;
    };

    // Exactly one item may hold the tab stop. Buttons default to
    // tabIndex 0, so a fresh render leaves every row tabbable until
    // this runs (and re-runs as rows mount/unmount).
    const normalize = () => {
      const all = items();
      if (!all.length) return;
      const current = all.filter((i) => i.tabIndex === 0);
      setActive(current.length === 1 ? current[0] : (current[0] ?? all[0]));
    };
    normalize();

    const observer = new MutationObserver(normalize);
    observer.observe(container, { childList: true, subtree: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const all = items();
      const idx = all.indexOf(document.activeElement as HTMLElement);
      if (idx === -1 || !all.length) return;
      e.preventDefault(); // keep the scroll container still; focus() scrolls as needed
      const next =
        e.key === "ArrowDown" ? all[Math.min(idx + 1, all.length - 1)]
        : e.key === "ArrowUp" ? all[Math.max(idx - 1, 0)]
        : e.key === "Home" ? all[0]
        : all[all.length - 1];
      if (next !== document.activeElement) {
        setActive(next);
        next.focus();
      }
    };

    // Keep the tab stop on whichever item was focused last, however it
    // got focus (click, arrow, find-by-VoiceOver).
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches?.(itemSelector)) setActive(target);
    };

    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("focusin", onFocusIn);
    return () => {
      observer.disconnect();
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("focusin", onFocusIn);
    };
  }, [containerRef, itemSelector]);
}
