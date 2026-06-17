import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";

/**
 * ⌘/ overlay listing every global shortcut. Self-contained: mounts once at
 * the root and listens for the "open-shortcuts-help" DOM event.
 */
export function KeyboardShortcutsHelp() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(open, panelRef, () => setOpen(false));

  useEffect(() => {
    const toggle = () => setOpen((o) => !o);
    document.addEventListener("open-shortcuts-help", toggle);
    return () => document.removeEventListener("open-shortcuts-help", toggle);
  }, []);

  // Nothing inside is focusable, so land focus on the panel itself —
  // VoiceOver reads it and Escape works from within.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="glass-float relative rounded-xl w-full max-w-md mx-4 p-5 focus:outline-none"
      >
        <h3 className="text-sm font-semibold text-text-primary mb-3">Keyboard shortcuts</h3>
        <div className="space-y-4">
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title}>
              <p className="section-label mb-1.5">
                {g.title}
              </p>
              <ul className="space-y-1 list-none p-0 m-0">
                {g.items.map(([keys, desc]) => (
                  <li key={keys} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-text-secondary">{desc}</span>
                    <kbd className="shrink-0 rounded-md border border-border bg-bg-tertiary px-1.5 py-0.5 text-caption text-text-muted">
                      {keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-4 text-caption text-text-muted">⌘/ toggles this panel</p>
      </div>
    </div>
  );
}
