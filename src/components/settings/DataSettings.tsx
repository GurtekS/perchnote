import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Trash2,
  ArchiveRestore,
  FolderOpen,
  HardDrive,
  FileText,
  Mic,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { useState, useEffect } from "react";
import { ConfirmDialog } from "../shared/ConfirmDialog";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DataSettings() {
  const queryClient = useQueryClient();
  const [showEmptyTrash, setShowEmptyTrash] = useState(false);
  const [retentionDays, setRetentionDays] = useState("0");

  const { data: stats } = useQuery({
    queryKey: ["storageStats"],
    queryFn: ipc.getStorageStats,
  });

  const { data: appPaths } = useQuery({
    queryKey: ["appPaths"],
    queryFn: ipc.getAppPaths,
  });

  const { data: deletedMeetings = [] } = useQuery({
    queryKey: ["deletedMeetings"],
    queryFn: ipc.listDeletedMeetings,
  });

  const { data: savedRetention } = useQuery({
    queryKey: ["setting", "retention_days"],
    queryFn: () => ipc.getSetting("retention_days"),
  });

  useEffect(() => {
    if (savedRetention) setRetentionDays(savedRetention);
  }, [savedRetention]);

  const handleBackup = async () => {
    try {
      const data = await ipc.exportAllData();
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `perchnote-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Backup exported successfully");
    } catch (e) {
      toast.error("Backup failed: " + String(e));
    }
  };

  const handleRevealDataFolder = async () => {
    if (!appPaths) return;
    try {
      await ipc.revealInFinder(appPaths.data_dir);
    } catch (e) {
      toast.error("Could not open folder: " + String(e));
    }
  };

  const handleRetentionChange = async (value: string) => {
    setRetentionDays(value);
    await ipc.setSetting("retention_days", value);
    queryClient.invalidateQueries({ queryKey: ["setting", "retention_days"] });
    toast.success(
      value === "0"
        ? "Meetings will be kept forever"
        : `Meetings will be auto-archived after ${value} days`
    );
  };

  const handleEmptyTrash = async () => {
    setShowEmptyTrash(false);
    for (const m of deletedMeetings) {
      await ipc.deleteMeeting(m.id);
    }
    queryClient.invalidateQueries({ queryKey: ["deletedMeetings"] });
    queryClient.invalidateQueries({ queryKey: ["storageStats"] });
    toast.success("Trash emptied");
  };

  const handleRestoreAll = async () => {
    for (const m of deletedMeetings) {
      await ipc.restoreMeeting(m.id);
    }
    queryClient.invalidateQueries({ queryKey: ["deletedMeetings"] });
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    toast.success(`Restored ${deletedMeetings.length} meeting${deletedMeetings.length !== 1 ? "s" : ""}`);
  };

  return (
    <div className="space-y-6">
      {/* Storage Usage */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Storage Usage</h3>
        <p className="text-xs text-text-muted mb-3">Overview of your local data.</p>
        {stats && (
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-lg border border-border bg-bg-tertiary text-center">
              <HardDrive size={16} className="mx-auto text-text-muted mb-1" />
              <p className="text-sm font-semibold text-text-primary">{formatBytes(stats.db_size_bytes)}</p>
              <p className="text-xs text-text-muted">Total storage</p>
            </div>
            <div className="p-3 rounded-lg border border-border bg-bg-tertiary text-center">
              <FileText size={16} className="mx-auto text-text-muted mb-1" />
              <p className="text-sm font-semibold text-text-primary">{stats.total_meetings}</p>
              <p className="text-xs text-text-muted">Meetings</p>
            </div>
            <div className="p-3 rounded-lg border border-border bg-bg-tertiary text-center">
              <Mic size={16} className="mx-auto text-text-muted mb-1" />
              <p className="text-sm font-semibold text-text-primary">{stats.total_transcripts}</p>
              <p className="text-xs text-text-muted">Transcripts</p>
            </div>
          </div>
        )}
      </section>

      {/* Backup */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Backup</h3>
        <p className="text-xs text-text-muted mb-3">Export your data or find it on disk.</p>
        <div className="flex items-center gap-3">
          <button
            onClick={handleBackup}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent/90 text-white text-sm font-medium transition-colors"
          >
            <Download size={14} />
            Export all data
          </button>
          <button
            onClick={handleRevealDataFolder}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover text-sm font-medium transition-colors"
          >
            <FolderOpen size={14} />
            Reveal data folder
          </button>
        </div>
      </section>

      {/* Data Retention */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Data Retention</h3>
        <p className="text-xs text-text-muted mb-3">Control how long meetings are kept before auto-archiving.</p>
        <select
          value={retentionDays}
          onChange={(e) => handleRetentionChange(e.target.value)}
          className="w-full bg-bg-tertiary text-text-primary text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
        >
          <option value="0">Keep meetings forever</option>
          <option value="30">Auto-archive after 30 days</option>
          <option value="60">Auto-archive after 60 days</option>
          <option value="90">Auto-archive after 90 days</option>
          <option value="180">Auto-archive after 180 days</option>
          <option value="365">Auto-archive after 365 days</option>
        </select>
      </section>

      {/* Trash */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Trash</h3>
        <p className="text-xs text-text-muted mb-3">
          {deletedMeetings.length === 0
            ? "Trash is empty."
            : `${deletedMeetings.length} deleted meeting${deletedMeetings.length !== 1 ? "s" : ""}.`}
        </p>
        {deletedMeetings.length > 0 && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowEmptyTrash(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors"
            >
              <Trash2 size={14} />
              Empty trash
            </button>
            <button
              onClick={handleRestoreAll}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover text-sm font-medium transition-colors"
            >
              <ArchiveRestore size={14} />
              Restore all
            </button>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={showEmptyTrash}
        title="Empty Trash"
        message={`Permanently delete ${deletedMeetings.length} meeting${deletedMeetings.length !== 1 ? "s" : ""}? This cannot be undone.`}
        confirmLabel="Empty Trash"
        variant="danger"
        onConfirm={handleEmptyTrash}
        onCancel={() => setShowEmptyTrash(false)}
      />
    </div>
  );
}
