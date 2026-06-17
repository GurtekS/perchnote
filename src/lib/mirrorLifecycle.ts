import { ipc, type MirrorWriteResult } from "./ipc";
import { toast } from "../stores/toastStore";

/**
 * The ONE mirror entry point (plan v8 B2). The post-enhance write and the
 * debounced re-mirror after note saves both funnel through mirrorMeeting,
 * so there is a single place that serializes, builds frontmatter (via
 * buildMirrorMarkdown, plan v8 B1), and calls write_md_mirror — which owns
 * paths, rename cleanup, the clobber guard, and the authoritative disabled
 * no-op on the Rust side. Everything here is best-effort: a mirror hiccup
 * must never surface in a save path — the one deliberate exception is the
 * clobber guard's conflict outcome (plan v10 #9), which toasts so the user
 * learns a .conflict.md exists. (Data Settings' "Sync all" keeps its own
 * loop so it can batch the tags/folders fetches across every meeting.)
 */

/** Trailing per-meeting debounce: one write ~5s after the last save. */
export const MIRROR_SAVE_DEBOUNCE_MS = 5_000;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Meetings whose mirror is currently conflicted (plan v10 #9). An unresolved
 *  external edit re-conflicts on every debounced write, but the user only
 *  needs telling once — a clean write clears the latch, so the NEXT distinct
 *  conflict speaks up again. */
const conflictNotified = new Set<string>();

/** Toast an external-edit conflict, once per conflict event. The backend kept
 *  the user's file and wrote the app's content to a `.conflict.md` beside it
 *  (one per note, latest wins) — say so, and offer the folder in Finder. */
function surfaceConflict(meetingId: string, result: MirrorWriteResult): void {
  if (!result?.conflicted) {
    conflictNotified.delete(meetingId);
    return;
  }
  if (conflictNotified.has(meetingId)) return;
  conflictNotified.add(meetingId);
  const file = result.path.slice(result.path.lastIndexOf("/") + 1);
  const dir = result.path.slice(0, result.path.lastIndexOf("/"));
  toast.action(
    `This note's file was edited outside Perchnote, so it was left alone — the latest notes were written to "${file}" beside it.`,
    "Show in Finder",
    // reveal_in_finder opens directories, so point it at the parent folder.
    () => void ipc.revealInFinder(dir).catch(() => {}),
    "Your edits were kept",
  );
}

/** Call after every note save; the mirror refreshes once the edits settle. */
export function scheduleMirror(meetingId: string): void {
  const timer = pending.get(meetingId);
  if (timer) clearTimeout(timer);
  pending.set(
    meetingId,
    setTimeout(() => {
      pending.delete(meetingId);
      void mirrorIfEnabled(meetingId);
    }, MIRROR_SAVE_DEBOUNCE_MS),
  );
}

/** Call before hard-deleting a meeting: a queued write firing mid-purge
 *  (between the backend's get_meeting check and the fs write) would leave
 *  an orphan vault file and a dead mirror_paths row behind. No-op when
 *  nothing is queued. */
export function cancelMirror(meetingId: string): void {
  conflictNotified.delete(meetingId); // a purged meeting's latch is stale
  const timer = pending.get(meetingId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pending.delete(meetingId);
}

/** Empty-trash purges every trashed meeting in one backend call — drop the
 *  whole queue rather than guessing which ids it will take. */
export function cancelAllMirrors(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  conflictNotified.clear();
}

/** The debounced path pre-checks the setting so save bursts with the mirror
 *  off cost one settings read, not a meeting+note+tags+folders fetch. */
async function mirrorIfEnabled(meetingId: string): Promise<void> {
  try {
    if ((await ipc.getSetting("md_mirror_enabled")) !== "true") return;
  } catch {
    return;
  }
  await mirrorMeeting(meetingId);
}

/**
 * Serialize and mirror one meeting now. When `doc` (a TipTap doc object) is
 * given it becomes the body — the post-enhance call passes its freshly
 * generated doc; otherwise the stored note's best content is used (AI if
 * present, else raw — the same preference "Sync all" applies). Never throws.
 */
export async function mirrorMeeting(meetingId: string, doc?: unknown): Promise<void> {
  try {
    const [{ serializeTiptapToMarkdown }, { buildMirrorMarkdown }] = await Promise.all([
      import("./tiptap/serializeTiptap"),
      import("./mirrorMarkdown"),
    ]);
    const meeting = await ipc.getMeeting(meetingId);
    if (!meeting) return;
    let body: string;
    if (doc !== undefined) {
      body = serializeTiptapToMarkdown(doc);
    } else {
      const note = await ipc.getNoteByMeeting(meetingId);
      const content = note?.generated_content || note?.raw_content;
      if (!content) return;
      body = serializeTiptapToMarkdown(JSON.parse(content));
      // An emptied note keeps its last mirror rather than truncating the
      // file to frontmatter — the same skip "Sync all" applies.
      if (!body.trim()) return;
    }
    const [tags, folders, audio] = await Promise.all([
      ipc.getMeetingTags(meetingId),
      ipc.getMeetingFolders(meetingId),
      // Recording path is frontmatter garnish (plan v8 B7) — never let its
      // failure cost the mirror itself.
      ipc.getRecordingPath(meetingId).catch(() => null),
    ]);
    const result = await ipc.writeMdMirror(
      meetingId,
      buildMirrorMarkdown(meeting, body, {
        tags: tags.map((t) => t.name),
        folders: folders.map((f) => f.name),
        audio,
      }),
    );
    // The one mirror outcome that must surface (plan v10 #9): the backend
    // refused to clobber an external edit and wrote a .conflict.md instead.
    surfaceConflict(meetingId, result);
  } catch {
    /* mirror is best-effort */
  }
}
