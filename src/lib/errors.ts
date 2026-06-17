/**
 * Raw Rust/IPC errors → copy a person can act on. Toast sites used to show
 * strings like `Failed to update note: database is locked` verbatim
 * (friction audit #14); the full raw error still lands in the console for
 * diagnosis.
 */
const PATTERNS: Array<[test: RegExp, message: string]> = [
  [/SYSTEM_AUDIO_PERMISSION_REQUIRED/i, "Screen Recording permission is needed for system audio."],
  [/database is locked|database table is locked/i, "The database is busy — try again in a moment."],
  [/no such file|os error 2\b/i, "A file was missing — it may have been moved or deleted."],
  [/permission denied|os error 13\b/i, "macOS blocked file access — check the app's permissions."],
  [/no space left|os error 28\b/i, "The disk is full — free up some space and try again."],
  [/template not found/i, "That template no longer exists — pick another in Settings → Templates."],
  [/api key|401|unauthorized|authentication/i, "The AI provider rejected the request — check your key in Settings → AI."],
  [/429|rate limit|overloaded/i, "The AI provider is rate-limiting — wait a moment and retry."],
  [/connection refused|error sending request|timed out|dns error|network/i,
    "Couldn't reach the AI provider — check your connection (for Ollama: is the server running?)."],
];

export function toUserMessage(e: unknown, fallback = "Something went wrong"): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Keep the full detail where it belongs.
  console.error("[error]", raw);
  for (const [test, message] of PATTERNS) {
    if (test.test(raw)) return message;
  }
  // Unknown error: show it, but trimmed of noise and bounded.
  const cleaned = raw.replace(/^(Error|error):\s*/g, "").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}…` : cleaned;
}
