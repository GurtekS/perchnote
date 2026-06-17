export type Politeness = "polite" | "assertive";
type AnnounceFn = (message: string, politeness: Politeness) => void;

let sink: AnnounceFn | null = null;

/** Wired by the <Announcer /> component; null outside the app shell. */
export function setAnnounceSink(fn: AnnounceFn | null) {
  sink = fn;
}

/**
 * Speak a message to screen readers without any visual UI. Routes into the
 * pre-mounted live regions in <Announcer /> — VoiceOver reliably announces
 * text *inserted into* an existing region, but often misses regions that
 * mount together with their content (the old per-toast role="alert").
 */
export function announce(message: string, politeness: Politeness = "polite") {
  sink?.(message, politeness);
}
