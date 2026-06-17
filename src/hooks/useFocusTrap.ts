import { useEffect, useRef, type RefObject } from "react";
import { pushOverlay } from "../lib/overlayStack";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Modal-dialog keyboard contract, shared by every overlay in the app:
 *
 * - Tab / Shift+Tab cycle within `containerRef` (and pull focus back in if
 *   it ever escapes to the page behind the dialog).
 * - Escape invokes `onEscape` — via the dismissal ladder, so with stacked
 *   overlays only the topmost closes.
 * - On deactivate, focus returns to the element that had it when the trap
 *   engaged — unless something else (e.g. navigation moving focus to the
 *   new view's heading) already claimed focus, which we never fight.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void,
) {
  // Keep the latest callback without re-arming the trap on identity changes.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;

    const invoker =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = pushOverlay(() => onEscapeRef.current?.());

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !containerRef.current) return;
      const focusable = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!containerRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      release();
      window.removeEventListener("keydown", handleKeyDown);
      // After the dialog unmounts, focus lands on <body>; give it back to
      // the invoker. setTimeout lets React finish removing the dialog first.
      window.setTimeout(() => {
        if (
          invoker?.isConnected &&
          (document.activeElement === document.body || document.activeElement === null)
        ) {
          invoker.focus();
        }
      }, 0);
    };
  }, [active, containerRef]);
}
