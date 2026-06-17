import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  Check,
  MoreHorizontal,
  Pencil,
  Pin,
  Clipboard,
  Trash2,
  FolderOpen,
  Download,
} from "lucide-react";
import { format } from "date-fns";
import { ipc, Meeting, buildFolderTree, FolderNode } from "../../lib/ipc";
import { serializeTiptapToMarkdown } from "../../lib/tiptap/serializeTiptap";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { useThemeStore, folderColorFromId } from "../../stores/themeStore";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { RecipesPanel } from "./RecipesPanel";

function renderFolderTree(
  nodes: FolderNode[],
  depth: number,
  isInSet: Set<string>,
  onToggle: (id: string, isIn: boolean) => void,
  accent: string
): React.ReactNode {
  return nodes.map(f => {
    const isIn = isInSet.has(f.id);
    return (
      <div key={f.id}>
        <button
          type="button"
          onClick={() => onToggle(f.id, isIn)}
          aria-label={`${isIn ? "Remove from" : "Add to"} folder ${f.name}`}
          className="w-full flex items-center gap-2 py-1.5 text-body-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          style={{ paddingLeft: `${12 + depth * 14}px`, paddingRight: "12px" }}
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: folderColorFromId(f.id, accent) }} />
          <span className="flex-1 text-left truncate">{f.name}</span>
          {isIn && <Check size={12} className="text-accent shrink-0" />}
        </button>
        {f.children.length > 0 && renderFolderTree(f.children, depth + 1, isInSet, onToggle, accent)}
      </div>
    );
  });
}

interface MeetingHeaderProps {
  meeting: Meeting;
  meetingId: string;
  saveStatus: "saved" | "saving" | "idle";
  isRecording: boolean;
  elapsedSeconds: number;
}

export function MeetingHeader({
  meeting,
  meetingId,
  saveStatus,
  isRecording,
  elapsedSeconds,
}: MeetingHeaderProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accentColor = useThemeStore(s => s.accentColor);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  // What the current edit session started from — an unchanged blur is a
  // no-op even if the title moved underneath (see handleTitleSave).
  const editSeedRef = useRef("");
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showFolderPopover, setShowFolderPopover] = useState(false);
  const [lastExportDir, setLastExportDir] = useState<string | null>(null);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Gates the Recipes affordance (plan v9 #6) — same posture as Ask AI and
  // catch-me-up: without an AI provider the button shouldn't exist at all.
  const { data: aiConfigured = false } = useQuery({
    queryKey: ["aiConfigured"],
    queryFn: ipc.checkAiConfigured,
    staleTime: 60_000,
  });

  const { data: folders = [] } = useQuery({
    queryKey: ["folders"],
    queryFn: ipc.listFolders,
  });

  const { data: meetingFolders = [] } = useQuery({
    queryKey: ["meetingFolders", meetingId],
    queryFn: () => ipc.getMeetingFolders(meetingId),
  });

  const folderTree = buildFolderTree(folders);
  const meetingFolderIdSet = new Set(meetingFolders.map(f => f.id));

  // Focus title input when editing
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // Close menu on click outside
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  // Close folder popover on outside click
  useEffect(() => {
    if (!showFolderPopover) return;
    const handleClick = () => setShowFolderPopover(false);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [showFolderPopover]);

  // Palette "Recipes…" row (discoverability batch): the panel's open state
  // lives here, so the palette reaches it via a DOM event — same pattern as
  // palette-enhance-notes and open-transcript-drawer.
  useEffect(() => {
    const handler = () => setRecipesOpen(true);
    document.addEventListener("open-recipes", handler);
    return () => document.removeEventListener("open-recipes", handler);
  }, []);

  const handleTitleSave = useCallback(async () => {
    const trimmed = editTitle.trim();
    // The second clause guards against a stale snapshot: if the title
    // changed underneath the edit session (the transcript auto-titler) and
    // the user blurs without typing, saving the untouched seed would
    // silently revert that change.
    if (trimmed && trimmed !== meeting.title && trimmed !== editSeedRef.current) {
      await ipc.updateMeetingTitle(meetingId, trimmed);
      queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      toast.success("Title updated");
    }
    setIsEditingTitle(false);
  }, [editTitle, meeting.title, meetingId, queryClient]);

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleTitleSave();
    if (e.key === "Escape") setIsEditingTitle(false);
  };

  const handleDelete = useCallback(async () => {
    setShowDeleteDialog(false);
    await ipc.softDeleteMeeting(meetingId);
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.success("Meeting moved to trash");
    navigate({ to: "/" });
  }, [meetingId, queryClient, navigate]);

  const handlePin = async () => {
    const pinned = await ipc.togglePinMeeting(meetingId);
    queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.info(pinned ? "Meeting pinned" : "Meeting unpinned");
    setShowMenu(false);
  };

  const handleCopyNotes = async () => {
    const noteData = await ipc.getNoteByMeeting(meetingId);
    const lines: string[] = [];
    lines.push(`# ${meeting.title}`);
    lines.push("");

    // Include AI-generated notes if present (handles both TipTap JSON and old structured format)
    if (noteData?.generated_content) {
      try {
        const gen = JSON.parse(noteData.generated_content);
        if (gen.type === "doc" || Array.isArray(gen.content)) {
          // New TipTap JSON format
          lines.push(serializeTiptapToMarkdown(gen));
        } else {
          // Old structured format: { summary, sections, action_items }
          if (gen.summary) { lines.push(gen.summary); lines.push(""); }
          for (const sec of gen.sections ?? []) {
            lines.push(`## ${sec.heading}`);
            for (const b of sec.bullets) lines.push(`- ${b}`);
            lines.push("");
          }
          if (gen.action_items?.length) {
            lines.push("## Action Items");
            for (const a of gen.action_items) {
              lines.push(`- ${a.task}${a.assignee ? ` (${a.assignee})` : ""}`);
            }
          }
        }
      } catch { /* skip */ }
    }

    // Include manual notes if present and different from AI notes
    if (noteData?.raw_content) {
      try {
        const raw = serializeTiptapToMarkdown(JSON.parse(noteData.raw_content));
        if (raw.trim()) {
          if (noteData.generated_content) {
            lines.push("");
            lines.push("## My Notes");
          }
          lines.push(raw);
        }
      } catch { /* skip */ }
    }

    await ipc.writeClipboard(lines.join("\n").trim());
    toast.success("Notes copied to clipboard");
    setShowMenu(false);
  };

  const handleExportMarkdown = async () => {
    const noteData = await ipc.getNoteByMeeting(meetingId);
    const transcript = await ipc.getTranscriptByMeeting(meetingId);
    const lines: string[] = [];
    lines.push(`# ${meeting.title}`);
    lines.push("");
    if (meeting.scheduled_start) {
      lines.push(`> Date: ${format(new Date(meeting.scheduled_start), "MMM d, yyyy h:mm a")}`);
    }
    lines.push("");
    // AI notes FIRST — they are the artifact people mean to share (deep
    // review P1: export silently omitted generated_content while Copy
    // Notes preferred it; recipients got scratch notes + transcript and
    // no summary or action items).
    if (noteData?.generated_content) {
      try {
        const gen = JSON.parse(noteData.generated_content);
        lines.push("## Notes");
        lines.push("");
        lines.push(serializeTiptapToMarkdown(gen));
        lines.push("");
      } catch {
        // skip
      }
    }
    if (noteData?.raw_content) {
      try {
        const content = JSON.parse(noteData.raw_content);
        lines.push(noteData?.generated_content ? "## My notes" : "## Notes");
        lines.push("");
        lines.push(serializeTiptapToMarkdown(content));
        lines.push("");
      } catch {
        // skip
      }
    }
    if (transcript?.segments) {
      try {
        const segs = JSON.parse(transcript.segments) as Array<{ text: string; speaker: string | null }>;
        lines.push("## Transcript");
        lines.push("");
        for (const seg of segs) {
          const prefix = seg.speaker ? `**${seg.speaker}:** ` : "";
          lines.push(`${prefix}${seg.text}`);
        }
      } catch {
        // skip
      }
    }
    const markdown = lines.join("\n");
    // CJK/emoji titles reduced to "" → an invisible ".md" dotfile on the
    // Desktop (whole-app review P3); fall back like the vault mirror does.
    const stem =
      meeting.title.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-").toLowerCase() ||
      "untitled-meeting";
    const filename = `${stem}.md`;
    try {
      const savedPath = await ipc.saveMarkdownExport(filename, markdown);
      // Use lastIndexOf safely — on macOS paths always have /, but guard against edge case
      const lastSlash = savedPath.lastIndexOf("/");
      const dir = lastSlash > 0 ? savedPath.substring(0, lastSlash) : savedPath;
      setLastExportDir(dir);
      toast.success("Exported to Desktop");
    } catch (e) {
      toast.error(toUserMessage(e), "Export failed");
    }
    setShowMenu(false);
  };

  // Date/duration now live solely on the metadata line below the header
  // (UI review #1 — they rendered three times on this screen).

  if (isRecording) {
    const mm = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
    const ss = String(elapsedSeconds % 60).padStart(2, "0");
    return (
      <>
        <header
          className="flex min-h-[56px] shrink-0 items-center gap-3 px-4 py-3 sm:px-5"
          style={{ borderBottom: "1px solid var(--glass-header-border)" }}
        >
          {/* Pulsing red dot */}
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0 recording-pulse"
            style={{ background: "var(--color-recording)" }}
          />
          {/* Title — editable inline */}
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              onBlur={handleTitleSave}
              maxLength={200}
              aria-label="Meeting title"
              className="flex-1 bg-transparent pb-0.5 text-base font-semibold text-text-primary border-b border-accent focus:outline-none"
            />
          ) : (
            <h1
              className="flex-1 cursor-text truncate text-lg font-semibold text-text-primary transition-colors hover:text-accent"
              onClick={() => { setEditTitle(meeting.title); editSeedRef.current = meeting.title; setIsEditingTitle(true); }}
              title="Click to rename"
            >
              {meeting.title}
            </h1>
          )}
          {/* Elapsed timer */}
          <span className="text-sm font-mono tabular-nums shrink-0" style={{ color: "var(--color-recording)" }}>
            {mm}:{ss}
          </span>
        </header>
      </>
    );
  }

  return (
    <>
      <header
        className="group flex min-h-[72px] shrink-0 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:px-5"
        style={{ borderBottom: "1px solid var(--glass-header-border)" }}
      >
        <div className="flex w-full min-w-0 items-start gap-3">
          {/* Back button */}
          <button
            type="button"
            onClick={() => navigate({ to: "/" })}
            className="icon-btn mt-0.5"
            title="Back to meetings"
            aria-label="Back to meetings"
          >
            <ArrowLeft size={16} />
          </button>

          {/* Title + date */}
          <div className="min-w-0 flex-1">
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                onBlur={handleTitleSave}
                maxLength={200}
                aria-label="Meeting title"
                className="w-full bg-transparent pb-0.5 text-base font-semibold text-text-primary border-b border-accent focus:outline-none"
              />
            ) : (
              <div
                className="group/title flex min-w-0 cursor-text items-center gap-1.5"
                title="Click to rename"
                onClick={() => {
                  setEditTitle(meeting.title);
                  editSeedRef.current = meeting.title;
                  setIsEditingTitle(true);
                }}
              >
                <h1 className="truncate text-lg font-semibold text-text-primary transition-colors group-hover/title:text-accent">
                  {meeting.title}
                </h1>
                <Pencil size={11} className="mb-0.5 shrink-0 text-text-muted opacity-0 transition-opacity group-hover/title:opacity-40 group-focus-within/title:opacity-60" />
              </div>
            )}
            <div
              className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"
              style={{ color: "rgba(var(--accent-rgb), 0.6)", fontSize: "11px" }}
            >
              {/* Save indicator */}
              {saveStatus === "saving" && (
                <span className="text-text-muted">Saving...</span>
              )}
              {saveStatus === "saved" && (
                <span className="saved-indicator flex items-center gap-0.5 text-accent/70">
                  <Check size={10} />
                  Saved
                </span>
              )}
            </div>

            {/* Folder pills */}
            <div className="relative mt-1 flex flex-wrap items-center gap-1.5">
              {meetingFolders.length > 0 ? (
                <>
                  {meetingFolders.map(f => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ to: "/folders/$folderId", params: { folderId: f.id } });
                      }}
                      className="flex max-w-[180px] items-center gap-1 rounded-full px-2 py-0.5 text-footnote text-text-muted transition-colors"
                      style={{ background: "var(--glass-search-bg)", border: "1px solid var(--glass-search-border)" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--glass-search-border)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--glass-search-bg)"; }}
                      aria-label={`Open folder ${f.name}`}
                      title={`Open “${f.name}” (⌘[ comes back here)`}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: folderColorFromId(f.id, accentColor) }} />
                      <span className="truncate">{f.name}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowFolderPopover(true); }}
                    className="flex items-center rounded-full px-1.5 py-0.5 text-footnote text-text-muted transition-colors hover:text-text-primary"
                    style={{ background: "var(--glass-search-bg)", border: "1px solid var(--glass-search-border)" }}
                    aria-label="Edit meeting folders"
                    title="Edit folders"
                  >
                    +
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowFolderPopover(true); }}
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 text-caption text-text-muted transition-colors hover:bg-bg-hover hover:text-accent"
                  aria-label="Add meeting to folder"
                >
                  + Add to folder
                </button>
              )}

              {/* Folder picker popover */}
              {showFolderPopover && (
                <div
                  className="glass-float absolute left-0 top-full mt-1 z-30 min-w-[180px] max-w-[240px] rounded-lg py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 py-1.5 text-caption font-medium text-text-muted">Add to folder</div>
                  <div className="my-1 border-t border-border" />
                  {folderTree.length === 0 ? (
                    <p className="px-3 py-2 text-caption text-text-muted">No folders yet</p>
                  ) : (
                    renderFolderTree(folderTree, 0, meetingFolderIdSet, async (folderId, isIn) => {
                      try {
                        if (isIn) await ipc.removeMeetingFromFolder(meetingId, folderId);
                        else await ipc.addMeetingToFolder(meetingId, folderId);
                        queryClient.invalidateQueries({ queryKey: ["meetingFolders", meetingId] });
                        queryClient.invalidateQueries({ queryKey: ["meetings"] });
                        queryClient.invalidateQueries({ queryKey: ["folders"] });
                      } catch (e) { toast.error(toUserMessage(e)); }
                      setShowFolderPopover(false);
                    }, accentColor)
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Action buttons — appear on hover */}
        <div className="flex shrink-0 items-center gap-1 self-end opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 sm:self-center">
          {/* Show in Finder button after export */}
          {lastExportDir && (
            <button
              type="button"
              onClick={() => { ipc.revealInFinder(lastExportDir); setLastExportDir(null); }}
              title="Show in Finder"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <FolderOpen size={13} />
              Show in Finder
            </button>
          )}

          {/* Recipes (plan v9 #6) — saved prompts run against this meeting */}
          {aiConfigured && (
            <button
              type="button"
              onClick={() => setRecipesOpen(true)}
              title="Recipes: run a saved prompt on this meeting"
              aria-label="Open recipes"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <BookOpen size={13} />
              Recipes
            </button>
          )}

          {/* Overflow menu */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setShowMenu(!showMenu)}
              className="icon-btn"
              title="More options"
              aria-label="More meeting options"
            >
              <MoreHorizontal size={16} />
            </button>

            {showMenu && (
              <div className="glass-float menu-dropdown absolute right-0 top-full mt-1 w-52 rounded-lg z-50 py-1">
                <button
                  type="button"
                  onClick={handlePin}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                >
                  <Pin size={14} />
                  {meeting.is_pinned ? "Unpin" : "Pin meeting"}
                </button>
                <button
                  type="button"
                  onClick={handleCopyNotes}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                >
                  <Clipboard size={14} />
                  Copy notes
                </button>
                <button
                  type="button"
                  onClick={handleExportMarkdown}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                >
                  <Download size={14} />
                  Export as Markdown
                </button>
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  onClick={() => {
                    setShowMenu(false);
                    setShowDeleteDialog(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-recording hover:bg-recording/10 transition-colors"
                >
                  <Trash2 size={14} />
                  Delete meeting…
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <ConfirmDialog
        open={showDeleteDialog}
        title="Delete Meeting"
        message={`Are you sure you want to delete "${meeting.title}"? This will move the meeting, notes, and transcript to trash.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteDialog(false)}
      />

      <RecipesPanel
        meetingId={meetingId}
        meetingTitle={meeting.title}
        isOpen={recipesOpen}
        onClose={() => setRecipesOpen(false)}
      />
    </>
  );
}


