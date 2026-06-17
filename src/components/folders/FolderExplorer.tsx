// src/components/folders/FolderExplorer.tsx
import { useMemo, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, FolderOpen, ChevronRight, ChevronDown } from "lucide-react";
import { ipc, buildFolderTree, FolderNode } from "../../lib/ipc";
import { FolderMeetings } from "./FolderMeetings";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { useThemeStore, generateFolderPalette, folderColorFromId } from "../../stores/themeStore";

interface FolderExplorerProps {
  activeFolderId: string | null;
}

function findNodeById(tree: FolderNode[], id: string): FolderNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

function buildBreadcrumb(tree: FolderNode[], targetId: string): FolderNode[] {
  function search(nodes: FolderNode[], path: FolderNode[]): FolderNode[] | null {
    for (const node of nodes) {
      const newPath = [...path, node];
      if (node.id === targetId) return newPath;
      const found = search(node.children, newPath);
      if (found) return found;
    }
    return null;
  }
  return search(tree, []) ?? [];
}

/** Large Finder-style folder icon card */
function FolderRow({
  node,
  color,
  lastActive,
  onOpen,
}: {
  node: FolderNode;
  color: string;
  lastActive: string | null;
  onOpen: () => void;
}) {
  const parts: string[] = [];
  if (node.meeting_count > 0) parts.push(`${node.meeting_count} meeting${node.meeting_count === 1 ? "" : "s"}`);
  if (node.children.length > 0) parts.push(`${node.children.length} folder${node.children.length === 1 ? "" : "s"}`);
  if (lastActive) parts.push(`active ${lastActive}`);
  return (
    <button
      type="button"
      className="ios-row"
      onClick={onOpen}
      aria-label={`Open ${node.name} folder`}
    >
      <span
        className="icon-chip"
        style={{ background: `linear-gradient(180deg, ${color}, ${color}cc)` }}
      >
        <FolderOpen size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-primary">{node.name}</span>
        <span className="block text-xs text-text-muted">
          {parts.length > 0 ? parts.join(" · ") : "Empty"}
        </span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-text-muted" />
    </button>
  );
}


/** Recursive row in the left tree panel */
function TreeRow({
  node,
  depth,
  activeFolderId,
  activeDropId,
  accentColor,
  onNavigate,
}: {
  node: FolderNode;
  depth: number;
  activeFolderId: string | null;
  activeDropId: string | null;
  accentColor: string;
  onNavigate: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(
    // Auto-expand if this node or a descendant is active
    () => {
      function hasActive(n: FolderNode): boolean {
        return n.id === activeFolderId || n.children.some(hasActive);
      }
      return hasActive(node);
    }
  );
  const isActive = node.id === activeFolderId;
  const isDropTarget = node.id === activeDropId;
  const color = folderColorFromId(node.id, accentColor);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        data-folder-drop={node.id}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md select-none transition-colors text-caption group ${
          isActive
            ? "bg-accent/12 text-text-primary font-medium"
            : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
        } ${isDropTarget ? "bg-accent/10 ring-1 ring-accent/50 text-text-primary" : ""}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {/* Expand/collapse toggle */}
        <button
          type="button"
          className="shrink-0 w-3.5 h-3.5 flex items-center justify-center text-text-muted/50 hover:text-text-muted transition-colors"
          onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
          title={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>

        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded bg-transparent text-left"
          onClick={() => onNavigate(node.id)}
          aria-current={isActive ? "page" : undefined}
          aria-label={`Open ${node.name} in folder tree`}
        >
          {/* Mini folder SVG */}
          <svg width="14" height="12" viewBox="0 0 56 48" fill="none" className="shrink-0">
            <rect x="0" y="10" width="56" height="38" rx="5" fill={color} opacity="0.85" />
            <path d="M0 10 Q0 6 4 6 L18 6 Q22 6 24 10 Z" fill={color} />
            <rect x="0" y="14" width="56" height="34" rx="5" fill={color} />
            <rect x="0" y="14" width="56" height="10" rx="5" fill="white" opacity="0.12" />
          </svg>

          <span className="flex-1 truncate">{node.name}</span>

          {/* Meeting count badge */}
          {node.meeting_count > 0 && (
            <span className={`text-footnote tabular-nums px-1 rounded ${isActive ? "text-accent/70" : "text-text-muted/50"}`}>
              {node.meeting_count}
            </span>
          )}
        </button>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children.map(child => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              activeFolderId={activeFolderId}
              activeDropId={activeDropId}
              accentColor={accentColor}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Left panel: full folder tree overview */
function FolderTreePanel({
  tree,
  activeFolderId,
  accentColor,
  onNavigate,
}: {
  tree: FolderNode[];
  activeFolderId: string | null;
  accentColor: string;
  onNavigate: (id: string | null) => void;
}) {
  const [activeDropId, setActiveDropId] = useState<string | null>(null);
  const totalMeetings = tree.reduce(function sum(acc: number, n: FolderNode): number {
    return acc + n.meeting_count + n.children.reduce(sum, 0);
  }, 0);

  useEffect(() => {
    const handler = (event: Event) => {
      const folderId = (event as CustomEvent<{ folderId: string | null }>).detail?.folderId ?? null;
      setActiveDropId(folderId);
    };
    document.addEventListener("meeting-drag-over", handler);
    return () => document.removeEventListener("meeting-drag-over", handler);
  }, []);

  return (
    <div className="w-52 shrink-0 border-r border-border flex flex-col overflow-hidden bg-bg-secondary/30">
      {/* Panel header */}
      <div className="px-3 py-2 border-b border-border/50 shrink-0">
        <button
          type="button"
          onClick={() => onNavigate(null)}
          className={`w-full flex items-center justify-between text-caption font-semibold uppercase tracking-wider transition-colors ${
            activeFolderId === null ? "text-accent" : "text-text-muted hover:text-text-primary"
          }`}
        >
          <span>All Folders</span>
          {totalMeetings > 0 && (
            <span className="text-footnote text-text-muted/60 normal-case tracking-normal font-normal tabular-nums">
              {totalMeetings} meetings
            </span>
          )}
        </button>
      </div>

      {/* Tree rows */}
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {tree.length === 0 ? (
          <p className="text-caption text-text-muted/40 px-3 py-2 italic">No folders</p>
        ) : (
          tree.map(node => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              activeFolderId={activeFolderId}
              activeDropId={activeDropId}
              accentColor={accentColor}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function FolderExplorer({ activeFolderId }: FolderExplorerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accentColor = useThemeStore(s => s.accentColor);
  const folderPalette = generateFolderPalette(accentColor);

  const { data: folders = [] } = useQuery({
    queryKey: ["folders"],
    queryFn: ipc.listFolders,
  });

  const tree = buildFolderTree(folders);
  const activeFolder = activeFolderId ? findNodeById(tree, activeFolderId) ?? null : null;
  const breadcrumb = activeFolderId ? buildBreadcrumb(tree, activeFolderId) : [];

  const navigateTo = (folderId: string | null) => {
    if (folderId) {
      navigate({ to: "/folders/$folderId", params: { folderId } });
    } else {
      navigate({ to: "/folders" });
    }
  };

  const handleNewRootFolder = async () => {
    try {
      const f = await ipc.createFolder("New Folder", folderPalette[0], "folder", null);
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      navigate({ to: "/folders/$folderId", params: { folderId: f.id } });
    } catch (e) { toast.error(toUserMessage(e)); }
  };

  // Last activity per folder (direct membership; UI review #3) — two cheap
  // cached queries the explorer mostly has warm already.
  const { data: allMeetings = [] } = useQuery({ queryKey: ["meetings"], queryFn: ipc.listMeetings, staleTime: 60_000 });
  const { data: membershipMap = {} } = useQuery({
    queryKey: ["folder-memberships"],
    queryFn: () => ipc.getFolderMembershipsMap(),
    staleTime: 60_000,
  });
  const lastActiveByFolder = useMemo(() => {
    const newest = new Map<string, string>();
    const dateOf = (m: { actual_start: string | null; created_at: string }) =>
      m.actual_start ?? m.created_at;
    for (const m of allMeetings) {
      for (const fid of (membershipMap as Record<string, string[]>)[m.id] ?? []) {
        const d = dateOf(m);
        if (!newest.has(fid) || d > (newest.get(fid) as string)) newest.set(fid, d);
      }
    }
    const out = new Map<string, string>();
    for (const [fid, iso] of newest) {
      out.set(fid, new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    }
    return out;
  }, [allMeetings, membershipMap]);

  // Which folders to show as the grid — if no active folder, show top-level
  // If active folder, show its subfolders (handled in FolderMeetings)
  const gridFolders = activeFolderId ? null : tree;

  return (
    <div className="h-full flex overflow-hidden">
      {/* Left tree panel — always visible */}
      <FolderTreePanel
        tree={tree}
        activeFolderId={activeFolderId}
        accentColor={accentColor}
        onNavigate={navigateTo}
      />

      {/* Right: toolbar + content */}
      <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center gap-2">
        {/* Breadcrumb */}
        <div className="flex-1 flex items-center gap-1 text-caption min-w-0 flex-wrap">
          <button
            type="button"
            onClick={() => navigateTo(null)}
            className="text-text-muted hover:text-text-primary transition-colors shrink-0 font-medium"
          >
            Folders
          </button>
          {breadcrumb.map((node, i) => (
            <span key={node.id} className="flex items-center gap-1 shrink-0">
              <ChevronRight size={11} className="text-text-muted/40" />
              {i === breadcrumb.length - 1 ? (
                <span className="text-text-primary font-medium truncate max-w-[160px]">{node.name}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => navigateTo(node.id)}
                  className="text-text-muted hover:text-text-primary transition-colors truncate max-w-[120px]"
                >
                  {node.name}
                </button>
              )}
            </span>
          ))}
        </div>

        <button
          type="button"
          onClick={handleNewRootFolder}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-caption text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
          title="Create a new folder"
        >
          <Plus size={12} />
          New Folder
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!activeFolderId && gridFolders ? (
          /* Root icon grid */
          <div className="flex-1 overflow-y-auto p-4">
            {gridFolders.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-text-muted">
                <FolderOpen size={40} className="opacity-20" />
                <p className="text-sm">No folders yet</p>
                <button
                  type="button"
                  onClick={handleNewRootFolder}
                  className="flex items-center gap-1.5 text-xs text-accent hover:underline"
                >
                  <Plus size={12} /> Create your first folder
                </button>
              </div>
            ) : (
              <div className="ios-group max-w-2xl">
                {gridFolders.map(node => (
                  <FolderRow
                    key={node.id}
                    node={node}
                    color={folderColorFromId(node.id, accentColor)}
                    lastActive={lastActiveByFolder.get(node.id) ?? null}
                    onOpen={() => navigateTo(node.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          /* Active folder contents — subfolders + meetings */
          <FolderMeetings
            folder={activeFolder}
            onNavigate={navigateTo}
          />
        )}
      </div>
      </div>
    </div>
  );
}
