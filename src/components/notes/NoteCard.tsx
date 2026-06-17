import { useState, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import { Mic, Lock, Volume2, MapPin, Clock, Monitor, Sparkles, Video } from "lucide-react";
import { useUIStore } from "../../stores/uiStore";
import { useQueryClient } from "@tanstack/react-query";
import { FolderInput } from "lucide-react";
import { Meeting, Folder, SearchResult, openLocation, isLocationUrl } from "../../lib/ipc";
import { useThemeStore, folderColorFromId } from "../../stores/themeStore";
import { ContextMenu, ContextMenuItem, ContextSubItem } from "../shared/ContextMenu";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useFolders } from "../../hooks/useFolders";
import { buildFolderTree, ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";

// Color palette for meeting avatars — muted, accessible, neutral tones.
const AVATAR_COLORS = [
  "#4a90d9", // blue
  "#5a9c6a", // green
  "#d97c4a", // orange
  "#7c6aaa", // violet
  "#c05070", // rose
  "#4a9c9c", // teal
  "#c0a040", // amber
  "#888888", // neutral
];


function getAvatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getDurationLabel(m: { actual_start?: string | null; actual_end?: string | null; scheduled_start?: string | null; scheduled_end?: string | null }): string | null {
  const start = m.actual_start || m.scheduled_start;
  const end = m.actual_end || m.scheduled_end;
  if (!start || !end) return null;
  const mins = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ""}`;
}

function parseAttendeesLabels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((a: unknown) => {
        if (typeof a === "string") {
          // Strip email domains, keep display name
          const atIdx = a.indexOf("@");
          return atIdx > 0 ? a.slice(0, atIdx) : a;
        }
        if (typeof a === "object" && a !== null) {
          const o = a as Record<string, string>;
          return o.name || o.email?.split("@")[0] || "";
        }
        return "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

interface NoteCardProps {
  meeting: Meeting;
  tags?: string[];
  searchMatch?: SearchResult;
  selected?: boolean;
  folder?: Folder | null;
  notePreview?: string;
  currentFolderId?: string | null;     // set when viewing inside a specific folder
  meetingFolderIds?: string[];          // folder IDs this meeting belongs to (for checkmarks)
}

export function NoteCard({
  meeting,
  tags = [],
  searchMatch,
  selected = false,
  notePreview,
  folder,
  currentFolderId,
  meetingFolderIds,
}: NoteCardProps) {
  const navigate = useNavigate();
  const dateStr = meeting.scheduled_start || meeting.actual_start || meeting.created_at;
  const timeStr = dateStr ? format(new Date(dateStr), "h:mm a") : "";

  const avatarColor = getAvatarColor(meeting.id);
  const avatarLetter = (meeting.title || "M").trim().charAt(0).toUpperCase();

  const attendees = parseAttendeesLabels(meeting.attendees);
  const attendeeLabel =
    attendees.length > 0
      ? attendees.slice(0, 2).join(" & ") +
        (attendees.length > 2 ? ` +${attendees.length - 2}` : "")
      : "";

  const showMatchSnippet =
    searchMatch && searchMatch.match_source !== "title" && searchMatch.snippet;

  const subline = showMatchSnippet
    ? searchMatch!.snippet
    : attendeeLabel || notePreview || "";

  const duration = getDurationLabel(meeting);

  const accentColor = useThemeStore(s => s.accentColor);
  const { data: folders = [] } = useFolders();
  const queryClient = useQueryClient();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  // Build flat list of folder sub-items (DFS walk with indent)
  const folderSubItems = useMemo(() => {
    const currentFolderIdSet = new Set(meetingFolderIds ?? []);
    const items: ContextSubItem[] = [];
    function walkTree(nodes: typeof folderTree, depth: number) {
      for (const node of nodes) {
        const isIn = currentFolderIdSet.has(node.id);
        items.push({
          label: node.name,
          icon: <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ background: node.color }} />,
          indent: depth,
          checked: isIn,
          onClick: async () => {
            try {
              if (isIn) {
                await ipc.removeMeetingFromFolder(meeting.id, node.id);
              } else {
                await ipc.addMeetingToFolder(meeting.id, node.id);
              }
              queryClient.invalidateQueries({ queryKey: ["meetings"] });
              queryClient.invalidateQueries({ queryKey: ["folders"] });
              queryClient.invalidateQueries({ queryKey: ["meetings", "folder", node.id] });
            } catch (e) { toast.error(toUserMessage(e)); }
          },
        });
        walkTree(node.children, depth + 1);
      }
    }
    walkTree(folderTree, 0);
    return items;
  }, [folderTree, meetingFolderIds, meeting.id, queryClient]);

  const contextMenuItems: ContextMenuItem[] = [
    {
      label: "Move to folder",
      icon: <FolderInput size={13} />,
      submenu: {
        title: "Move to folder",
        items: folderSubItems.length > 0 ? folderSubItems : [{ label: "No folders yet", onClick: () => {}, indent: 0 }],
      },
    },
    ...(currentFolderId ? [{
      label: "Remove from this folder",
      onClick: async () => {
        try {
          await ipc.removeMeetingFromFolder(meeting.id, currentFolderId);
          queryClient.invalidateQueries({ queryKey: ["folders"] });
          queryClient.invalidateQueries({ queryKey: ["meetings", "folder", currentFolderId] });
          queryClient.invalidateQueries({ queryKey: ["folderMeetings", currentFolderId] });
        } catch (e) { toast.error(toUserMessage(e)); }
      },
    }] : []),
    {
      divider: true,
      label: "Delete meeting",
      variant: "danger" as const,
      onClick: () => setShowDeleteDialog(true),
    },
  ];

  return (
    <>
      <ContextMenu items={contextMenuItems}>
        <Link
          to="/meeting/$id"
          params={{ id: meeting.id }}
          className={`flex items-center gap-3 px-4 py-2 rounded-[var(--radius-md)] border border-transparent transition-colors duration-100 group ${
            selected
              ? "bg-accent/8 shadow-[inset_2.5px_0_0_var(--color-accent)]"
              : "hover:bg-bg-hover hover:border-border/60"
          }`}
          aria-label={`Open ${meeting.title}`}
          title={
            searchMatch?.match_start_ms != null
              ? "Open meeting at the matching moment"
              : "Open meeting. Drag to a folder or use the context menu for more actions."
          }
          onClick={() => {
            // Search → jump-to-moment: MeetingView consumes this on mount,
            // keyed to this meeting so it can't replay anywhere else.
            if (searchMatch?.match_start_ms != null) {
              useUIStore.getState().setPendingSeek(meeting.id, searchMatch.match_start_ms);
            }
          }}
          draggable
          onDragStart={e => e.dataTransfer.setData("meetingId", meeting.id)}
        >
          {/* Avatar circle */}
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-body-sm font-semibold shrink-0 select-none"
            style={{ background: avatarColor }}
          >
            {meeting.status === "recording" ? (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
              </span>
            ) : (
              avatarLetter
            )}
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0">
            <p className="text-body-sm font-medium text-text-primary leading-tight line-clamp-2">
              {meeting.status === "recording" && (
                <Mic size={10} className="inline mr-1.5 text-recording" />
              )}
              {meeting.title}
            </p>
            {subline && (
              <p className="text-caption text-text-muted line-clamp-2 mt-0.5 leading-tight">
                {showMatchSnippet && (
                  <span className="text-accent/60 mr-1">
                    {searchMatch!.match_source === "transcript"
                      ? "Transcript:"
                      : searchMatch!.match_source === "semantic"
                      ? "Related:"
                      : "Notes:"}
                  </span>
                )}
                {subline}
              </p>
            )}
            {tags.length > 0 && (
              <div className="flex gap-1 mt-0.5">
                {tags.slice(0, 2).map((tag) => (
                  // Tags read path (deep review P2: tags were write-only —
                  // collected everywhere, clickable nowhere). A chip click
                  // opens /meetings filtered to that tag.
                  <button
                    type="button"
                    key={tag}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      navigate({ to: "/meetings", search: { tag } });
                    }}
                    className="text-footnote px-1.5 py-0.5 rounded-full bg-accent/10 text-accent/80 hover:bg-accent/20 hover:text-accent transition-colors"
                    title={`Show all meetings tagged “${tag}”`}
                  >
                    {tag}
                  </button>
                ))}
                {tags.length > 2 && (
                  <span className="text-footnote text-text-muted">+{tags.length - 2}</span>
                )}
              </div>
            )}
            {/* Metadata chips: duration, location, platform */}
            {(duration || meeting.location || (meeting.platform && meeting.platform !== "unknown")) && (
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {duration && (
                  <span className="flex items-center gap-0.5 text-footnote text-text-muted">
                    <Clock size={9} className="shrink-0" />
                    {duration}
                  </span>
                )}
                {meeting.location && (
                  <button
                    onClick={e => { e.preventDefault(); e.stopPropagation(); openLocation(meeting.location!); }}
                    className="flex items-center gap-0.5 text-footnote text-accent/70 hover:text-accent transition-colors max-w-[140px]"
                    title={isLocationUrl(meeting.location) ? meeting.location : `Open in Maps: ${meeting.location}`}
                  >
                    <MapPin size={9} className="shrink-0" />
                    <span className="truncate">{meeting.location}</span>
                  </button>
                )}
                {meeting.platform && meeting.platform !== "unknown" && (
                  <span className="flex items-center gap-0.5 text-footnote text-text-muted">
                    <Monitor size={9} className="shrink-0" />
                    {meeting.platform}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right meta: time + folder dot + lock */}
          <div className="shrink-0 flex flex-col items-end gap-0.5 ml-1">
            <div className="flex items-center gap-1">
              {folder && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: folderColorFromId(folder.id, accentColor) }}
                  title={folder.name}
                />
              )}
              {meeting.calendar_event_id && (
                <Lock size={9} className="text-text-muted/40" />
              )}
              {timeStr && (
                <span className="text-caption text-text-muted tabular-nums">{timeStr}</span>
              )}
            </div>
            {/* Join & Record: calendar-synced meetings carry a call link the
                UI never surfaced — open it and start recording in one click. */}
            {meeting.meeting_url &&
              (meeting.status === "upcoming" || meeting.status === "ready") && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    ipc.openUrl(meeting.meeting_url!).catch(() => {});
                    useUIStore.getState().setPendingAutoStart(meeting.id);
                    navigate({ to: "/meeting/$id", params: { id: meeting.id } });
                  }}
                  className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-footnote font-medium text-accent hover:bg-accent/20 transition-colors"
                  title="Open the call link and start recording"
                >
                  <Video size={9} className="shrink-0" />
                  Join & record
                </button>
              )}
            {/* One-click Enhance for transcribed-but-unenhanced meetings */}
            {meeting.note_status === "none" && meeting.status === "complete" && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  useUIStore.getState().setPendingAutoEnhance(true);
                  navigate({ to: "/meeting/$id", params: { id: meeting.id } });
                }}
                className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-footnote font-medium text-accent hover:bg-accent/20 transition-colors"
                title="Generate AI notes for this meeting now"
              >
                <Sparkles size={9} className="shrink-0" />
                Enhance
              </button>
            )}
            {meeting.device_name && meeting.status !== "recording" && (
              <div
                className="flex items-center gap-0.5 text-footnote text-text-muted/40"
                title={`Recorded with: ${meeting.device_name}${meeting.system_audio_captured ? " + system audio" : ""}`}
              >
                <Mic size={8} className="shrink-0" />
                {meeting.system_audio_captured && <Volume2 size={8} className="shrink-0" />}
              </div>
            )}
          </div>
        </Link>
      </ContextMenu>
      <ConfirmDialog
        open={showDeleteDialog}
        title="Delete meeting"
        message="This meeting will be moved to the trash. You can restore it from Settings → Data."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          try {
            // Soft delete — the same contract as the meeting header and
            // sidebar list. Hard delete (audio + rows gone forever) lives
            // only behind Settings → Data → Empty trash; this card's
            // right-click previously skipped the trash entirely.
            await ipc.softDeleteMeeting(meeting.id);
            toast.success("Meeting moved to trash");
            queryClient.invalidateQueries({ queryKey: ["meetings"] });
            queryClient.invalidateQueries({ queryKey: ["folderMeetings"] });
            queryClient.invalidateQueries({ queryKey: ["folderMembershipsMap"] });
            queryClient.invalidateQueries({ queryKey: ["meetings", "folder"] });
          } catch (e) { toast.error(toUserMessage(e)); }
          setShowDeleteDialog(false);
        }}
        onCancel={() => setShowDeleteDialog(false)}
      />
    </>
  );
}
