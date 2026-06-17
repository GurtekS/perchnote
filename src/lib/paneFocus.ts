const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * F6 pane cycling (plan v6 item 8): move keyboard focus between the major
 * panes — meeting list, main content, transcript drawer — without tabbing
 * through everything in between. Panes are any visible `[data-pane]`
 * element; Shift+F6 goes backwards.
 */
export function cyclePaneFocus(dir: 1 | -1) {
  const panes = Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane]"),
  ).filter((p) => p.offsetParent !== null);
  if (panes.length === 0) return;

  // Innermost pane containing focus: descendants follow ancestors in
  // document order, so the last match wins (drawer nests inside main).
  const containing = panes.filter((p) => p.contains(document.activeElement));
  const currentIdx = containing.length
    ? panes.indexOf(containing[containing.length - 1])
    : dir === 1
      ? -1 // forward from nowhere → first pane
      : 0; //  backward from nowhere → last pane

  const next = panes[(currentIdx + dir + panes.length) % panes.length];
  focusPane(next);
}

function focusPane(pane: HTMLElement) {
  // Candidates in preference order; a hidden one (the notes editor stays
  // mounted but invisible while the Live Transcript shows — QA audit
  // finding 4) refuses focus, so VERIFY each landed and fall through.
  const candidates = [
    pane.querySelector<HTMLElement>('[data-roving-item][tabindex="0"]'),
    pane.querySelector<HTMLElement>('[contenteditable="true"]'),
    ...Array.from(pane.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)),
  ].filter((el): el is HTMLElement => !!el);
  for (const target of candidates) {
    target.focus();
    if (document.activeElement === target) return;
  }
  pane.tabIndex = -1;
  pane.focus();
}
