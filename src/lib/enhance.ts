import type { QueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc";
import { announce } from "./announce";
import { generatedNotesToTiptap, GeneratedNotes } from "./tiptap/generatedNotesToTiptap";

export interface EnhanceRunResult {
  generated: GeneratedNotes;
  tiptapJson: string;
  rawMarkdown: string;
}

/**
 * The one enhance flow, shared by the Enhance button and instant recap
 * (plan v3 rank 2): read the user's raw notes, generate structured notes,
 * convert to TipTap, persist atomically (raw preserved alongside generated
 * so an autosave can't interleave), and refresh the caches. Callers handle
 * their own UI (toast/notification/editor injection).
 */
/** Per-meeting in-flight latch (whole-app review P2): clicking Enhance
 *  right after stop raced the default-on instant recap into two concurrent
 *  LLM generations — double cost, and the loser polluted the one
 *  previous-version slot. Every enhance path funnels through runEnhance,
 *  so this is the single choke point. */
const enhancing = new Set<string>();

export async function runEnhance(
  queryClient: QueryClient,
  meetingId: string,
  opts: { templateId?: string | null; currentContent?: string | null; focusHint?: string | null } = {},
): Promise<EnhanceRunResult> {
  if (enhancing.has(meetingId)) {
    throw new Error("Notes are already being enhanced for this meeting");
  }
  enhancing.add(meetingId);
  try {
    // Generation runs 15-40s with only visual progress; tell screen readers
    // it started. Completion/failure announce via the caller's toast.
    announce("Enhancing notes…");
    // Ensure the note row exists and resolve the raw content we'll preserve.
    // The button passes its live editor content (may be ahead of autosave);
    // the auto path reads what's stored.
    const noteData = await ipc.getOrCreateNote(meetingId);
    const rawContent = opts.currentContent ?? noteData.raw_content ?? null;

    let userNotes = "";
    if (rawContent) {
      try {
        userNotes = extractPlainText(JSON.parse(rawContent));
      } catch {
        /* leave empty */
      }
    }
    // The "Emphasize" hint rides the user-notes channel, which the prompt
    // already weights heavily. (It was collected-and-dropped before —
    // friction audit #7.)
    const hint = opts.focusHint?.trim();
    if (hint) {
      userNotes = `[Emphasize in the summary: ${hint}]\n${userNotes}`;
    }

    const generated = await ipc.generateMeetingNotes(meetingId, userNotes, opts.templateId ?? null);
    const doc = generatedNotesToTiptap(generated);
    const tiptapJson = JSON.stringify(doc);

    // Plaintext rendering for the typing-animation overlay.
    const rawMarkdown = [
      generated.summary,
      ...generated.sections.flatMap((s) => [`## ${s.heading}`, ...s.bullets.map((b) => `- ${b}`)]),
      generated.action_items.length ? "## Action Items" : "",
      ...generated.action_items.map((a) => {
        const suffix = [a.assignee, a.deadline].filter(Boolean).join(" — ");
        return suffix ? `- ${a.task} (${suffix})` : `- ${a.task}`;
      }),
    ]
      .filter(Boolean)
      .join("\n\n");

    // Persist with the enhance receipt (plan v10 #2) when the backend stamped
    // one — provenance + the as-of-generation transcript hash, and the prior
    // generated version moves into the one previous-version slot. The plain
    // write stays as the fallback so a missing receipt can never block saving.
    if (generated.receipt) {
      await ipc.updateNoteContentsWithReceipt(
        noteData.id,
        rawContent,
        tiptapJson,
        generated.receipt.provider,
        generated.receipt.model,
        generated.receipt.transcript_sha ?? null,
      );
    } else {
      await ipc.updateNoteContents(noteData.id, rawContent, tiptapJson);
    }
    // Markdown mirror (plan v3 rank 10): freshly enhanced notes land in
    // ~/Documents/Perchnote as .md when the mirror is enabled (no-op otherwise).
    // mirrorMeeting (plan v8 B2) is the shared best-effort entry point — its
    // body comes from buildMirrorMarkdown, byte-identical with "Sync all", and
    // a mirror hiccup can never fail the enhance itself.
    try {
      const { mirrorMeeting } = await import("./mirrorLifecycle");
      await mirrorMeeting(meetingId, doc);
    } catch {
      /* mirror is best-effort */
    }
    queryClient.invalidateQueries({ queryKey: ["note", meetingId] });
    queryClient.invalidateQueries({ queryKey: ["action-items"] });
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    queryClient.invalidateQueries({ queryKey: ["note-previews"] });

    return { generated, tiptapJson, rawMarkdown };

  } finally {
    enhancing.delete(meetingId);
  }
}

/** Extract plain text from TipTap JSON for AI context.
 *
 * Walks EVERY block type the editor can produce. The original version
 * only knew headings/paragraphs/bullet lists, so task lists (including
 * carry-forward items), action items, callouts, toggles, quotes, and
 * code blocks silently vanished from what the AI saw (friction audit #4).
 */
export function extractPlainText(doc: Record<string, unknown>): string {
  const lines: string[] = [];
  walkBlocks((doc.content as TiptapNode[] | undefined) ?? [], lines, "");
  return lines.join("\n");
}

type TiptapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
};

/** All inline text under a node, concatenated. */
function inlineText(node: TiptapNode): string {
  if (node.text) return node.text;
  // ⌘D chips: surface the mark to the AI as [m:ss] so flagged moments
  // anchor the summary the way the old plain-text marks did.
  if (node.type === "timestampChip") {
    const ms = typeof node.attrs?.ms === "number" ? node.attrs.ms : 0;
    const totalSec = Math.floor(ms / 1000);
    return `[${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, "0")}]`;
  }
  return (node.content ?? []).map(inlineText).join("");
}

/** "[m:ss] " when the block carries a recording-time anchor, else "". */
function anchorPrefix(node: TiptapNode): string {
  const ms = node.attrs?.t_ms;
  if (typeof ms !== "number" || ms < 0) return "";
  const totalSec = Math.floor(ms / 1000);
  return `[${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, "0")}] `;
}

function walkBlocks(nodes: TiptapNode[], lines: string[], prefix: string) {
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
      case "paragraph": {
        const text = inlineText(node);
        // The silent t_ms anchor (stamped while recording) becomes a
        // visible [m:ss] prefix here — the AI matches the fragment to
        // the transcript moment it was typed against (capture 7).
        if (text.trim()) lines.push(prefix + anchorPrefix(node) + text);
        break;
      }
      case "bulletList":
      case "orderedList":
        for (const item of node.content ?? []) {
          walkBlocks(item.content ?? [], lines, `${prefix}- `);
        }
        break;
      case "taskList":
        for (const item of node.content ?? []) {
          const mark = item.attrs?.checked ? "[x]" : "[ ]";
          walkBlocks(item.content ?? [], lines, `${prefix}- ${mark} `);
        }
        break;
      case "actionItem": {
        // Atomic node: the text lives in attrs, not content.
        const task = String(node.attrs?.task ?? "").trim();
        if (task) {
          const who = node.attrs?.assignee ? ` (${node.attrs.assignee})` : "";
          const due = node.attrs?.deadline ? ` due ${node.attrs.deadline}` : "";
          const mark = node.attrs?.done ? "[x]" : "[ ]";
          lines.push(`${prefix}- ${mark} ${task}${who}${due}`);
        }
        break;
      }
      case "blockquote":
        walkBlocks(node.content ?? [], lines, `${prefix}> `);
        break;
      case "codeBlock": {
        const code = inlineText(node);
        if (code.trim()) lines.push(prefix + code);
        break;
      }
      case "toggle": {
        const summary = String(node.attrs?.summary ?? "").trim();
        if (summary) lines.push(prefix + summary);
        walkBlocks(node.content ?? [], lines, prefix);
        break;
      }
      case "callout":
        walkBlocks(node.content ?? [], lines, prefix);
        break;
      case "pastedImage":
        // Pasted screenshots (plan v9 #13) carry no text for the AI —
        // skip silently rather than leak a disk path into the prompt.
        break;
      default:
        // Unknown future block: salvage its inline text rather than drop it.
        if (node.content) {
          const text = inlineText(node);
          if (text.trim()) lines.push(prefix + text);
        }
    }
  }
}
