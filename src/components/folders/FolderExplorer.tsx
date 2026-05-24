// src/components/folders/FolderExplorer.tsx
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, FolderOpen, ChevronRight, ChevronDown } from "lucide-react";
import { ipc, buildFolderTree, FolderNode } from "../../lib/ipc";
import { FolderMeetings } from "./FolderMeetings";
import { toast } from "../../stores/toastStore";
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
function FolderCard({
  node,
  color,
  onOpen,
}: {
  node: FolderNode;
  color: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="group flex min-h-[104px] w-[96px] flex-col items-center gap-1.5 rounded-xl p-3 text-center transition-colors hover:bg-bg-hover focus-visible:bg-bg-hover"
      onClick={onOpen}
      title={`Open ${node.name}`}
      aria-label={`Open ${node.name} folder`}
    >
      {/* Folder icon */}
      <div className="relative">
        <svg width="56" height="48" viewBox="0 0 56 48" fill="none">
          {/* folder back */}
          <rect x="0" y="10" width="56" height="38" rx="5" fill={color} opacity="0.85" />
          {/* tab */}
          <path d="M0 10 Q0 6 4 6 L18 6 Q22 6 24 10 Z" fill={color} />
          {/* folder front shine */}
          <rect x="0" y="14" width="56" height="34" rx="5" fill={color} />
          <rect x="0" y="14" width="56" height="10" rx="5" fill="white" opacity="0.12" />
        </svg>
        {node.meeting_count > 0 && (
          <span className="absolute -bottom-0.5 -right-0.5 bg-bg-secondary border border-border text-[9px] text-text-muted px-1 rounded-full tabular-nums leading-4">
            {node.meeting_count}
          </span>
        )}
      </div>
      {/* Name */}
      <span className="max-w-[80px] break-words text-center text-[12px] font-medium leading-tight text-text-primary group-hover:text-accent group-focus-visible:text-accent">
        {node.name}
      </span>
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
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md select-none transition-colors text-[12px] group ${
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
            <span className={`text-[10px] tabular-nums px-1 rounded ${isActive ? "text-accent/70" : "text-text-muted/50"}`}>
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
          className={`w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider transition-colors ${
            activeFolderId === null ? "text-accent" : "text-text-muted hover:text-text-primary"
          }`}
        >
          <span>All Folders</span>
          {totalMeetings > 0 && (
            <span className="text-[10px] text-text-muted/60 normal-case tracking-normal font-normal tabular-nums">
              {totalMeetings} meetings
            </span>
          )}
        </button>
      </div>

      {/* Tree rows */}
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {tree.length === 0 ? (
          <p className="text-[11px] text-text-muted/40 px-3 py-2 italic">No folders</p>
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
    } catch (e) { toast.error(String(e)); }
  };

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
        <div className="flex-1 flex items-center gap-1 text-[12px] min-w-0 flex-wrap">
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
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
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
              <div className="flex flex-wrap gap-2 content-start">
                {gridFolders.map(node => (
                  <FolderCard
                    key={node.id}
                    node={node}
                    color={folderColorFromId(node.id, accentColor)}
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
