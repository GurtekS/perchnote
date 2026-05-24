import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  MoreHorizontal,
  Pencil,
  Pin,
  Clipboard,
  Trash2,
  FolderOpen,
  Download,
} from "lucide-react";
import { format, intervalToDuration } from "date-fns";
import { ipc, Meeting, buildFolderTree, FolderNode } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { useThemeStore, folderColorFromId } from "../../stores/themeStore";
import { ConfirmDialog } from "../shared/ConfirmDialog";

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
          className="w-full flex items-center gap-2 py-1.5 text-[13px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showFolderPopover, setShowFolderPopover] = useState(false);
  const [lastExportDir, setLastExportDir] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const handleTitleSave = useCallback(async () => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== meeting.title) {
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
          lines.push(extractTextFromTiptap(gen));
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
        const raw = extractTextFromTiptap(JSON.parse(noteData.raw_content));
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
    if (noteData?.raw_content) {
      try {
        const content = JSON.parse(noteData.raw_content);
        lines.push("## Notes");
        lines.push("");
        lines.push(extractTextFromTiptap(content));
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
    const filename = `${meeting.title.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-").toLowerCase()}.md`;
    try {
      const savedPath = await ipc.saveMarkdownExport(filename, markdown);
      // Use lastIndexOf safely — on macOS paths always have /, but guard against edge case
      const lastSlash = savedPath.lastIndexOf("/");
      const dir = lastSlash > 0 ? savedPath.substring(0, lastSlash) : savedPath;
      setLastExportDir(dir);
      toast.success("Exported to Desktop");
    } catch (e) {
      toast.error("Export failed: " + String(e));
    }
    setShowMenu(false);
  };

  // Date display
  const dateStr = meeting.scheduled_start
    ? format(new Date(meeting.scheduled_start), "MMM d, yyyy 'at' h:mm a")
    : format(new Date(meeting.created_at), "MMM d, yyyy");

  // Duration (only after meeting ends)
  let durationStr = "";
  if (meeting.actual_start && meeting.actual_end) {
    const dur = intervalToDuration({
      start: new Date(meeting.actual_start),
      end: new Date(meeting.actual_end),
    });
    const h = dur.hours ?? 0;
    const m = dur.minutes ?? 0;
    if (h > 0 && m > 0) durationStr = `${h}h ${m}m`;
    else if (h > 0) durationStr = `${h}h`;
    else if (m > 0) durationStr = `${m}m`;
    else durationStr = "< 1m";
  }

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
              className="flex-1 cursor-text truncate text-[18px] font-semibold text-text-primary transition-colors hover:text-accent"
              onClick={() => { setEditTitle(meeting.title); setIsEditingTitle(true); }}
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
            <ArrowLeft size={17} />
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
                  setIsEditingTitle(true);
                }}
              >
                <h1 className="truncate text-[18px] font-semibold text-text-primary transition-colors group-hover/title:text-accent">
                  {meeting.title}
                </h1>
                <Pencil size={11} className="mb-0.5 shrink-0 text-text-muted opacity-0 transition-opacity group-hover/title:opacity-40 group-focus-within/title:opacity-60" />
              </div>
            )}
            <div
              className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"
              style={{ color: "rgba(var(--accent-rgb), 0.6)", fontSize: "11px" }}
            >
              <span className="truncate">{dateStr}</span>
              {durationStr && (
                <>
                  <span className="opacity-40">|</span>
                  <span>{durationStr}</span>
                </>
              )}
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
                meetingFolders.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowFolderPopover(true); }}
                    className="flex max-w-[180px] items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-text-muted transition-colors"
                    style={{ background: "var(--glass-search-bg)", border: "1px solid var(--glass-search-border)" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--glass-search-border)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--glass-search-bg)"; }}
                    aria-label="Edit meeting folders"
                    title="Edit meeting folders"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: folderColorFromId(f.id, accentColor) }} />
                    <span className="truncate">{f.name}</span>
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowFolderPopover(true); }}
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-accent"
                  aria-label="Add meeting to folder"
                >
                  + Add to folder
                </button>
              )}

              {/* Folder picker popover */}
              {showFolderPopover && (
                <div
                  className="absolute left-0 top-full mt-1 z-30 min-w-[180px] max-w-[240px] rounded-lg border py-1 shadow-xl"
                  style={{ background: "var(--popup-bg)", borderColor: "var(--popup-border)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 py-1.5 text-[11px] font-medium text-text-muted">Add to folder</div>
                  <div className="my-1 border-t border-border" />
                  {folderTree.length === 0 ? (
                    <p className="px-3 py-2 text-[12px] text-text-muted">No folders yet</p>
                  ) : (
                    renderFolderTree(folderTree, 0, meetingFolderIdSet, async (folderId, isIn) => {
                      try {
                        if (isIn) await ipc.removeMeetingFromFolder(meetingId, folderId);
                        else await ipc.addMeetingToFolder(meetingId, folderId);
                        queryClient.invalidateQueries({ queryKey: ["meetingFolders", meetingId] });
                        queryClient.invalidateQueries({ queryKey: ["meetings"] });
                        queryClient.invalidateQueries({ queryKey: ["folders"] });
                      } catch (e) { toast.error(String(e)); }
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

          {/* Overflow menu */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setShowMenu(!showMenu)}
              className="icon-btn"
              title="More options"
              aria-label="More meeting options"
            >
              <MoreHorizontal size={17} />
            </button>

            {showMenu && (
              <div className="menu-dropdown absolute right-0 top-full mt-1 w-52 border rounded-lg shadow-xl z-50 py-1" style={{ background: "var(--popup-bg)", borderColor: "var(--popup-border)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
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
    </>
  );
}

/** Extract plain text from TipTap JSON content for markdown export */
function extractTextFromTiptap(doc: Record<string, unknown>): string {
  const lines: string[] = [];
  const content = doc.content as Array<Record<string, unknown>> | undefined;
  if (!content) return "";

  for (const node of content) {
    if (node.type === "paragraph") {
      const textContent = (node.content as Array<{ text?: string }> | undefined)
        ?.map((c) => c.text || "")
        .join("") || "";
      lines.push(textContent);
    } else if (node.type === "bulletList") {
      const items = node.content as Array<Record<string, unknown>> | undefined;
      if (items) {
        for (const item of items) {
          const paraContent = (item.content as Array<Record<string, unknown>> | undefined)?.[0];
          const text = (paraContent?.content as Array<{ text?: string }> | undefined)
            ?.map((c) => c.text || "")
            .join("") || "";
          lines.push(`- ${text}`);
        }
      }
    } else if (node.type === "heading") {
      const level = (node.attrs as Record<string, unknown>)?.level || 1;
      const text = (node.content as Array<{ text?: string }> | undefined)
        ?.map((c) => c.text || "")
        .join("") || "";
      lines.push(`${"#".repeat(level as number)} ${text}`);
    }
  }

  return lines.join("\n");
}
