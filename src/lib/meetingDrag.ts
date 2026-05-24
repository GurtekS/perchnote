// Pointer-event based drag-and-drop for meetings.
// Replaces HTML5 drag API which is unreliable in Tauri's WKWebView on macOS.

let _pendingMeetingId: string | null = null;
let _pendingTitle = "";
let _pendingStartX = 0;
let _pendingStartY = 0;

let _draggingMeetingId: string | null = null;
let _ghost: HTMLDivElement | null = null;
let _dragOccurred = false; // true if drag threshold was exceeded

const DRAG_THRESHOLD = 5;

export function startPendingDrag(meetingId: string, title: string, x: number, y: number) {
  _pendingMeetingId = meetingId;
  _pendingTitle = title;
  _pendingStartX = x;
  _pendingStartY = y;
  _dragOccurred = false;
}

export function checkThresholdAndBegin(x: number, y: number): boolean {
  if (!_pendingMeetingId || _draggingMeetingId) return false;
  const dx = x - _pendingStartX;
  const dy = y - _pendingStartY;
  if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return false;

  _draggingMeetingId = _pendingMeetingId;
  _dragOccurred = true;

  // Create floating ghost label
  _ghost = document.createElement("div");
  _ghost.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    `left:${x + 14}px`,
    `top:${y + 6}px`,
    "background:var(--color-bg-secondary,#1e1e2e)",
    "border:1px solid var(--color-border,#313244)",
    "border-radius:6px",
    "padding:5px 10px",
    "font-size:12px",
    "color:var(--color-text-primary,#cdd6f4)",
    "white-space:nowrap",
    "max-width:220px",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "opacity:0.92",
    "box-shadow:0 4px 14px rgba(0,0,0,0.45)",
    "z-index:9999",
    "user-select:none",
  ].join(";");
  _ghost.textContent = _pendingTitle;
  document.body.appendChild(_ghost);
  document.body.style.cursor = "grabbing";

  return true;
}

export function updateDragPosition(x: number, y: number) {
  if (!_ghost) return;
  _ghost.style.left = `${x + 14}px`;
  _ghost.style.top = `${y + 6}px`;
}

export function getDraggingMeetingId(): string | null {
  return _draggingMeetingId;
}

export function consumeDragOccurred(): boolean {
  const v = _dragOccurred;
  _dragOccurred = false;
  return v;
}

/** Returns the meeting ID that was being dragged (if any), then cleans up. */
export function endDrag(): string | null {
  const meetingId = _draggingMeetingId;
  _pendingMeetingId = null;
  _draggingMeetingId = null;
  _ghost?.remove();
  _ghost = null;
  document.body.style.cursor = "";
  return meetingId;
}
