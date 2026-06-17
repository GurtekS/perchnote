// src/components/folders/FolderTree.tsx
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ChevronDown, Folder as FolderIcon, Plus, MoreHorizontal, Check } from "lucide-react";
import { FolderNode, Folder, ipc } from "../../lib/ipc";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { useThemeStore, generateFolderPalette, folderColorFromId } from "../../stores/themeStore";

interface FolderTreeProps {
  tree: FolderNode[];
  activeFolderId: string | null;
  onSelect: (folder: Folder) => void;
  onMove: (id: string, newParentId: string | null) => void;
}

export function FolderTree({ tree, activeFolderId, onSelect, onMove }: FolderTreeProps) {
  const accentColor = useThemeStore(s => s.accentColor);
  const folderColors = generateFolderPalette(accentColor);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    if (!activeFolderId) return {};
    const init: Record<string, boolean> = {};
    function markAncestors(nodes: FolderNode[], targetId: string): boolean {
      for (const node of nodes) {
        if (node.id === targetId) return true;
        if (markAncestors(node.children, targetId)) {
          init[node.id] = true;
          return true;
        }
      }
      return false;
    }
    markAncestors(tree, activeFolderId);
    return init;
  });
  useEffect(() => {
    if (!activeFolderId) return;
    setExpanded(prev => {
      const next = { ...prev };
      function markAncestors(nodes: FolderNode[], targetId: string): boolean {
        for (const node of nodes) {
          if (node.id === targetId) return true;
          if (markAncestors(node.children, targetId)) {
            next[node.id] = true;
            return true;
          }
        }
        return false;
      }
      markAncestors(tree, activeFolderId);
      return next;
    });
  }, [activeFolderId, tree]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FolderNode | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pointerDropId, setPointerDropId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const handler = (event: Event) => {
      const folderId = (event as CustomEvent<{ folderId: string | null }>).detail?.folderId ?? null;
      setPointerDropId(folderId);
    };
    document.addEventListener("meeting-drag-over", handler);
    return () => document.removeEventListener("meeting-drag-over", handler);
  }, []);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["folders"] });
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
  };

  const handleRenameCommit = async (folder: Folder) => {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === folder.name) return;
    try {
      await ipc.renameFolder(folder.id, trimmed);
      invalidate();
    } catch (e) { toast.error(toUserMessage(e)); }
  };

  const handleDelete = (node: FolderNode) => {
    if (node.children.length > 0 || node.meeting_count > 0) {
      setDeleteTarget(node);
    } else {
      ipc.deleteFolder(node.id).then(invalidate).catch(e => toast.error(toUserMessage(e)));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.children.length > 0) {
        await ipc.deleteFolderRecursive(deleteTarget.id);
      } else {
        await ipc.deleteFolder(deleteTarget.id);
      }
      invalidate();
    } catch (e) { toast.error(toUserMessage(e)); }
    setDeleteTarget(null);
  };

  const handleNewSubfolder = async (parentNode: FolderNode) => {
    try {
      const f = await ipc.createFolder("New Folder", parentNode.color, "folder", parentNode.id);
      invalidate();
      setExpanded(prev => ({ ...prev, [parentNode.id]: true }));
      setRenamingId(f.id);
      setRenameValue("New Folder");
    } catch (e) { toast.error(toUserMessage(e)); }
  };

  const renderNode = (node: FolderNode, depth: number) => {
    const isActive = node.id === activeFolderId;
    const isExpanded = expanded[node.id];
    const isRenaming = renamingId === node.id;
    const isDragOver = dragOverId === node.id || pointerDropId === node.id;
    const showMenu = menuOpenId === node.id;

    return (
      <div key={node.id}>
        <div
          data-folder-drop={node.id}
          className={`group flex items-center gap-0.5 py-1 rounded-md cursor-pointer transition-colors select-none ${
            isActive ? "bg-accent/10 text-text-primary" : "hover:bg-bg-hover text-text-secondary hover:text-text-primary"
          } ${isDragOver ? "bg-accent/10 ring-1 ring-accent/60" : ""}`}
          style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: "8px" }}
          onClick={() => { if (!isRenaming) onSelect(node); }}
          draggable
          onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData("folderId", node.id); }}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverId(node.id); }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={async e => {
            e.preventDefault(); e.stopPropagation(); setDragOverId(null);
            const fid = e.dataTransfer.getData("folderId");
            const mid = e.dataTransfer.getData("meetingId");
            if (fid && fid !== node.id) { onMove(fid, node.id); }
            else if (mid) {
              try { await ipc.addMeetingToFolder(mid, node.id); invalidate(); }
              catch (e) { toast.error(toUserMessage(e)); }
            }
          }}
        >
          {/* Chevron */}
          <button
            type="button"
            className="shrink-0 w-4 h-4 flex items-center justify-center opacity-50 hover:opacity-100"
            onClick={e => { e.stopPropagation(); setExpanded(prev => ({ ...prev, [node.id]: !prev[node.id] })); }}
            disabled={node.children.length === 0}
            title={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          >
            {node.children.length > 0
              ? (isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />)
              : <span className="w-3" />}
          </button>
          {/* Folder icon */}
          <FolderIcon size={13} className="shrink-0" style={{ color: folderColorFromId(node.id, accentColor) }} />
          {/* Name / rename input */}
          {isRenaming ? (
            <input
              autoFocus
              className="flex-1 text-body-sm bg-transparent outline-none border-b border-accent min-w-0 ml-1"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleRenameCommit(node); if (e.key === "Escape") setRenamingId(null); }}
              onBlur={() => handleRenameCommit(node)}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span className="flex-1 text-body-sm truncate ml-1">{node.name}</span>
          )}
          {/* Count badge */}
          {node.meeting_count > 0 && !isRenaming && (
            <span className="text-footnote text-text-muted/50 tabular-nums shrink-0 ml-1">{node.meeting_count}</span>
          )}
          {/* Hover actions */}
          {!isRenaming && (
            <div className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                title="New subfolder"
                aria-label={`Create subfolder in ${node.name}`}
                className="p-0.5 rounded hover:bg-bg-tertiary"
                onClick={e => { e.stopPropagation(); handleNewSubfolder(node); }}
              ><Plus size={10} /></button>
              <button
                type="button"
                title="Folder actions"
                aria-label={`${node.name} folder actions`}
                aria-expanded={showMenu}
                className="p-0.5 rounded hover:bg-bg-tertiary"
                onClick={e => { e.stopPropagation(); setMenuOpenId(showMenu ? null : node.id); setColorPickerId(null); }}
              ><MoreHorizontal size={10} /></button>
            </div>
          )}
        </div>
        {/* Inline context menu */}
        {showMenu && (
          <div
            className="glass-float ml-8 mr-2 rounded-lg py-1 text-body-sm z-50"
            onClick={e => e.stopPropagation()}
          >
            <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => { setRenamingId(node.id); setRenameValue(node.name); setMenuOpenId(null); }}>
              Rename
            </button>
            <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => setColorPickerId(colorPickerId === node.id ? null : node.id)}>
              Change color
            </button>
            {colorPickerId === node.id && (
              <div className="flex gap-1.5 px-3 py-2 flex-wrap">
                {folderColors.map(c => (
                  <button key={c} type="button" title={c}
                    aria-label={`Set folder color ${c}`}
                    className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center"
                    style={{ background: c }}
                    onClick={async () => {
                      try { await ipc.updateFolder(node.id, undefined, c, undefined); invalidate(); }
                      catch (e) { toast.error(toUserMessage(e)); }
                      setColorPickerId(null); setMenuOpenId(null);
                    }}>
                    {c === node.color && <Check size={9} className="text-white" />}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => { handleNewSubfolder(node); setMenuOpenId(null); }}>
              New subfolder
            </button>
            <div className="my-1 border-t border-border" />
            <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-recording/10 text-recording transition-colors"
              onClick={() => { setMenuOpenId(null); handleDelete(node); }}>
              Delete
            </button>
          </div>
        )}
        {/* Children */}
        {isExpanded && node.children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div
      className="min-h-full"
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        const fid = e.dataTransfer.getData("folderId");
        if (fid) onMove(fid, null);
      }}
    >
      {tree.map(node => renderNode(node, 0))}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete folder"
        message={
          deleteTarget?.children.length
            ? "Delete this folder and all subfolders? Meetings will be unlinked but not deleted."
            : "Remove this folder? Meetings will be unlinked but not deleted."
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
