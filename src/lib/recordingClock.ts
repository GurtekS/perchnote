/**
 * The recording's elapsed clock, readable from anywhere without prop
 * drilling — TipTap extensions (block time anchors) live outside the React
 * tree that knows the meeting's start time. MeetingView feeds it while
 * recording; null means "not recording" and disables stamping.
 */
let elapsedMs: number | null = null;

export function setRecordingElapsedMs(ms: number | null) {
  elapsedMs = ms;
}

export function getRecordingElapsedMs(): number | null {
  return elapsedMs;
}
