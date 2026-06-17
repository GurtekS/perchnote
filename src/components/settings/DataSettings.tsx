import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Trash2,
  ArchiveRestore,
  FolderOpen,
  ShieldCheck,
  Loader2,
  HardDrive,
  FileText,
  Mic,
} from "lucide-react";
import { ipc, Meeting } from "../../lib/ipc";
import { cancelAllMirrors } from "../../lib/mirrorLifecycle";
import { toast } from "../../stores/toastStore";
import { toUserMessage } from "../../lib/errors";
import { useState, useEffect } from "react";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import {
  primarySettingsButtonClass,
  secondarySettingsButtonClass,
  secondarySettingsButtonCompactClass,
  settingsInputClass,
} from "./settingsUi";

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
  const [archiving, setArchiving] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ path: string; bytes: number; modified: string } | null>(null);
  const [restoring, setRestoring] = useState(false);

  const { data: stats } = useQuery({
    queryKey: ["storageStats"],
    queryFn: ipc.getStorageStats,
  });

  // Storage truth (plan v7 lifetime 15): the database is a rounding error
  // next to the WAVs — show where the bytes actually are.
  const { data: breakdown } = useQuery({
    queryKey: ["storageBreakdown"],
    queryFn: ipc.getStorageBreakdown,
  });
  const totalBytes = breakdown
    ? breakdown.db_bytes + breakdown.recordings_bytes + breakdown.attachments_bytes + breakdown.backups_bytes
    : stats?.db_size_bytes ?? 0;

  // Audio retention (lifetime 16, opt-in): only WAVs, never notes/transcripts.
  const [audioRetention, setAudioRetention] = useState("0");
  const { data: savedAudioRetention } = useQuery({
    queryKey: ["setting", "audio_retention_days"],
    queryFn: () => ipc.getSetting("audio_retention_days"),
  });
  useEffect(() => {
    if (savedAudioRetention) setAudioRetention(savedAudioRetention);
  }, [savedAudioRetention]);
  const audioRetentionDays = parseInt(audioRetention, 10) || 0;
  const { data: retentionPreview } = useQuery({
    queryKey: ["retentionPreview", audioRetentionDays],
    queryFn: () => ipc.previewAudioRetention(audioRetentionDays),
    enabled: audioRetentionDays > 0,
  });
  const handleAudioRetentionChange = async (value: string) => {
    setAudioRetention(value);
    await ipc.setSetting("audio_retention_days", value === "0" ? "" : value);
    queryClient.invalidateQueries({ queryKey: ["setting", "audio_retention_days"] });
    toast.success(
      value === "0"
        ? "Audio kept forever"
        : `Audio older than ${value} days will be removed (notes and transcripts stay)`,
    );
  };

  const [audioDeleteTarget, setAudioDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const handleDeleteAudio = async () => {
    if (!audioDeleteTarget) return;
    try {
      const freed = await ipc.deleteMeetingAudio(audioDeleteTarget.id);
      toast.success(`Audio deleted. ${formatBytes(freed)} freed. Notes and transcript kept.`);
      queryClient.invalidateQueries({ queryKey: ["storageBreakdown"] });
    } catch (e) {
      toast.error(toUserMessage(e));
    }
    setAudioDeleteTarget(null);
  };
  const handleToggleKeep = async (id: string, keep: boolean) => {
    try {
      await ipc.setAudioKeep(id, keep);
      queryClient.invalidateQueries({ queryKey: ["storageBreakdown"] });
      queryClient.invalidateQueries({ queryKey: ["retentionPreview"] });
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  };

  const { data: appPaths } = useQuery({
    queryKey: ["appPaths"],
    queryFn: ipc.getAppPaths,
  });

  const { data: deletedMeetings = [] } = useQuery({
    queryKey: ["deletedMeetings"],
    queryFn: ipc.listDeletedMeetings,
  });

  // Archived was a one-way door: actions existed everywhere, but no surface
  // listed archived meetings or could bring one back (friction audit #6).
  const { data: archivedData } = useQuery({
    queryKey: ["archivedMeetings"],
    queryFn: ipc.listArchivedMeetings,
  });
  const archivedMeetings = archivedData ?? [];
  const handleUnarchive = async (id: string) => {
    try {
      await ipc.unarchiveMeeting(id);
      queryClient.invalidateQueries({ queryKey: ["archivedMeetings"] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      toast.success("Meeting restored to your list");
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  };

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
      toast.error(toUserMessage(e), "Backup failed");
    }
  };

  // Full checksummed archive: db snapshot + recordings + attachments,
  // verified end-to-end right after writing so "backed up" means provably so.
  const handleArchive = async () => {
    setArchiving(true);
    try {
      const summary = await ipc.exportBackupArchive();
      const report = await ipc.verifyBackupArchive(summary.path);
      if (report.ok) {
        toast.success(
          `Backup verified. ${summary.files} files, ${formatBytes(summary.bytes)}, saved to Desktop`
        );
      } else {
        console.error("[backup verification]", report.problems);
        toast.error(
          "Backup saved, but verification found a problem. Don't rely on this file. Try exporting again.",
          "Backup verification failed",
        );
      }
    } catch (e) {
      toast.error(toUserMessage(e), "Backup failed");
    } finally {
      setArchiving(false);
    }
  };

  const { data: backupArchives = [] } = useQuery({
    queryKey: ["backupArchives"],
    queryFn: ipc.listBackupArchives,
    enabled: showRestore,
  });

  // Restore: verify + stage, then relaunch — the swap happens on boot, the
  // current database is preserved under backups/pre-restore-*.
  const handleRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      await ipc.restoreBackupArchive(restoreTarget.path);
      toast.success("Backup verified and staged. Restarting…");
      setTimeout(() => ipc.restartApp(), 900);
    } catch (e) {
      toast.error(toUserMessage(e), "Restore failed");
      setRestoring(false);
      setRestoreTarget(null);
    }
  };

  const { data: mdMirror = "" } = useQuery({
    queryKey: ["setting", "md_mirror_enabled"],
    queryFn: () => ipc.getSetting("md_mirror_enabled").then((v) => v ?? ""),
  });
  const [syncingMd, setSyncingMd] = useState(false);

  const handleMdMirrorChange = async (on: boolean) => {
    await ipc.setSetting("md_mirror_enabled", on ? "true" : "false");
    queryClient.invalidateQueries({ queryKey: ["setting", "md_mirror_enabled"] });
    toast.success(on ? "Markdown mirror on (Documents/Perchnote)" : "Markdown mirror off");
  };

  // Layout migrates lazily (plan v8 B4): each meeting's file moves the next
  // time it mirrors; "Sync all" below is the apply-it-now button.
  const { data: mirrorLayout = "flat" } = useQuery({
    queryKey: ["setting", "md_mirror_layout"],
    queryFn: () => ipc.getSetting("md_mirror_layout").then((v) => v || "flat"),
  });

  const handleMirrorLayoutChange = async (value: string) => {
    await ipc.setSetting("md_mirror_layout", value);
    queryClient.invalidateQueries({ queryKey: ["setting", "md_mirror_layout"] });
    toast.success("Layout saved. Files move as notes save, or Sync all now");
  };

  // Serialize every meeting's best notes (AI if present, else raw) to files.
  // Contents come from buildMirrorMarkdown (plan v8 B1), the same writer the
  // post-enhance mirror uses — the two paths produce byte-identical files.
  const handleSyncAllMd = async () => {
    setSyncingMd(true);
    try {
      const [{ serializeTiptapToMarkdown }, { buildMirrorMarkdown }] = await Promise.all([
        import("../../lib/tiptap/serializeTiptap"),
        import("../../lib/mirrorMarkdown"),
      ]);
      const meetings = await ipc.listMeetings();
      // Frontmatter inputs in three round-trips total, not three per meeting.
      const [tagsByMeeting, folderIdsByMeeting, folders] = await Promise.all([
        ipc.getTagsForMeetings(meetings.map((m) => m.id)),
        ipc.getFolderMembershipsMap(),
        ipc.listFolders(),
      ]);
      const folderName = new Map(folders.map((f) => [f.id, f.name]));
      let written = 0;
      let conflicts = 0;
      for (const m of meetings) {
        try {
          const note = await ipc.getNoteByMeeting(m.id);
          const body = note?.generated_content || note?.raw_content;
          if (!body) continue;
          const md = serializeTiptapToMarkdown(JSON.parse(body));
          if (!md.trim()) continue;
          const audio = await ipc.getRecordingPath(m.id).catch(() => null);
          const result = await ipc.writeMdMirror(
            m.id,
            buildMirrorMarkdown(m, md, {
              tags: (tagsByMeeting[m.id] ?? []).map((t) => t.name),
              folders: (folderIdsByMeeting[m.id] ?? [])
                .map((id) => folderName.get(id))
                .filter((name): name is string => name !== undefined),
              audio,
            }),
          );
          // The clobber guard (plan v10 #9) kept the user's externally
          // edited file and wrote a .conflict.md beside it — count those
          // and report once, instead of toasting per file.
          if (result?.conflicted) conflicts++;
          written++;
        } catch {
          /* per-meeting failures don't stop the sweep */
        }
      }
      toast.success(`Mirrored ${written} meeting${written === 1 ? "" : "s"} to Documents/Perchnote`);
      if (conflicts > 0) {
        toast.warning(
          conflicts === 1
            ? "1 file had your edits. Wrote .conflict.md beside it"
            : `${conflicts} files had your edits. Wrote .conflict.md beside them`,
        );
      }
    } catch (e) {
      toast.error(toUserMessage(e), "Sync failed");
    } finally {
      setSyncingMd(false);
    }
  };

  const handleRevealDataFolder = async () => {
    if (!appPaths) return;
    try {
      await ipc.revealInFinder(appPaths.data_dir);
    } catch (e) {
      toast.error(toUserMessage(e), "Couldn't open the folder");
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
    try {
      // A debounced mirror firing mid-purge could resurrect a vault file
      // for a meeting the backend is deleting — drop every queued timer
      // before the hard delete starts.
      cancelAllMirrors();
      // One command instead of a per-meeting IPC loop; the backend also
      // compacts the database when the purge fragments it.
      const n = await ipc.emptyTrash();
      toast.success(`Trash emptied. ${n} meeting${n === 1 ? "" : "s"} permanently removed`);
    } catch (e) {
      toast.error(toUserMessage(e));
    }
    queryClient.invalidateQueries({ queryKey: ["deletedMeetings"] });
    queryClient.invalidateQueries({ queryKey: ["storageStats"] });
    queryClient.invalidateQueries({ queryKey: ["storageBreakdown"] });
  };

  // Trash auto-empty (plan v7 #20, default Never — auto-deleting notes is
  // only OK because the user explicitly trashed these meetings).
  const [trashRetention, setTrashRetention] = useState("0");
  const { data: savedTrashRetention } = useQuery({
    queryKey: ["setting", "trash_retention_days"],
    queryFn: () => ipc.getSetting("trash_retention_days"),
  });
  useEffect(() => {
    if (savedTrashRetention) setTrashRetention(savedTrashRetention);
  }, [savedTrashRetention]);
  const handleTrashRetentionChange = async (value: string) => {
    setTrashRetention(value);
    await ipc.setSetting("trash_retention_days", value === "0" ? "" : value);
    queryClient.invalidateQueries({ queryKey: ["setting", "trash_retention_days"] });
    toast.success(
      value === "0"
        ? "Trash is kept until you empty it"
        : `Trashed meetings will be permanently removed after ${value} days`,
    );
  };

  const [confirmForever, setConfirmForever] = useState<Meeting | null>(null);
  const handleRestoreOne = async (m: Meeting) => {
    try {
      await ipc.restoreMeeting(m.id);
      queryClient.invalidateQueries({ queryKey: ["deletedMeetings"] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      toast.success(`"${m.title}" restored`);
    } catch (e) {
      toast.error(toUserMessage(e));
    }
  };
  const handleDeleteForever = async (m: Meeting) => {
    try {
      await ipc.deleteMeeting(m.id);
      queryClient.invalidateQueries({ queryKey: ["deletedMeetings"] });
      toast.success(`"${m.title}" permanently deleted`);
    } catch (e) {
      toast.error(toUserMessage(e));
    } finally {
      setConfirmForever(null);
    }
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
            <div className="card p-3 text-center">
              <HardDrive size={16} className="mx-auto text-text-muted mb-1" />
              <p className="text-sm font-semibold text-text-primary">{formatBytes(totalBytes)}</p>
              <p className="text-xs text-text-muted">Total storage</p>
            </div>
            <div className="card p-3 text-center">
              <FileText size={16} className="mx-auto text-text-muted mb-1" />
              <p className="text-sm font-semibold text-text-primary">{stats.total_meetings}</p>
              <p className="text-xs text-text-muted">Meetings</p>
            </div>
            <div className="card p-3 text-center">
              <Mic size={16} className="mx-auto text-text-muted mb-1" />
              <p className="text-sm font-semibold text-text-primary">{stats.total_transcripts}</p>
              <p className="text-xs text-text-muted">Transcripts</p>
            </div>
          </div>
        )}

        {/* Where the bytes are — recordings dwarf everything else */}
        {breakdown && totalBytes > 0 && (
          <div className="mt-3">
            <div className="flex h-2 overflow-hidden rounded-full bg-bg-tertiary">
              {([
                ["bg-accent", breakdown.recordings_bytes],
                ["bg-blue-400", breakdown.db_bytes],
                ["bg-purple-400", breakdown.attachments_bytes],
                ["bg-text-muted/40", breakdown.backups_bytes],
              ] as const).map(([cls, bytes], i) =>
                bytes > 0 ? (
                  <div key={i} className={cls} style={{ width: `${(bytes / totalBytes) * 100}%` }} />
                ) : null,
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-footnote text-text-muted">
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />Audio {formatBytes(breakdown.recordings_bytes)}</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-400" />Database {formatBytes(breakdown.db_bytes)}</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-purple-400" />Attachments {formatBytes(breakdown.attachments_bytes)}</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-text-muted/40" />Backups {formatBytes(breakdown.backups_bytes)}</span>
            </div>
          </div>
        )}

        {/* Largest recordings — per-item reclaim without touching notes */}
        {breakdown && breakdown.largest.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-text-muted hover:text-text-secondary">
              Largest recordings
            </summary>
            <div className="mt-2 space-y-1">
              {breakdown.largest.map((r) => (
                <div key={r.meeting_id} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-bg-hover">
                  <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{r.title}</span>
                  {r.date && <span className="shrink-0 text-footnote text-text-muted">{r.date.slice(0, 10)}</span>}
                  <span className="w-16 shrink-0 text-right text-footnote text-text-muted">{formatBytes(r.bytes)}</span>
                  <button
                    type="button"
                    onClick={() => handleToggleKeep(r.meeting_id, !r.keep)}
                    aria-pressed={r.keep}
                    title={r.keep ? "Audio kept forever (exempt from retention)" : "Keep this audio forever"}
                    className={`shrink-0 rounded px-1.5 py-0.5 text-footnote transition-colors ${
                      r.keep ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    {r.keep ? "Kept" : "Keep"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAudioDeleteTarget({ id: r.meeting_id, title: r.title })}
                    className="shrink-0 rounded px-1.5 py-0.5 text-footnote text-text-muted transition-colors hover:text-red-400"
                  >
                    Delete audio
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* Audio retention */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Audio retention</h3>
        <p className="text-xs text-text-muted mb-3">
          Recordings are the bulk of your storage (~175 MB per meeting-hour).
          Optionally remove audio after a while. Notes and transcripts are
          always kept, and meetings marked “Keep” are never touched.
        </p>
        <select
          value={audioRetention}
          onChange={(e) => handleAudioRetentionChange(e.target.value)}
          aria-label="Audio retention period"
          className={`${settingsInputClass} w-full`}
        >
          <option value="0">Keep audio forever (default)</option>
          <option value="30">Remove audio after 30 days</option>
          <option value="90">Remove audio after 90 days</option>
          <option value="365">Remove audio after 1 year</option>
        </select>
        {audioRetentionDays > 0 && retentionPreview && (
          <p className="mt-2 text-xs text-text-muted">
            {retentionPreview.files === 0
              ? "Nothing is old enough to remove right now."
              : `Next sweep removes ${retentionPreview.files} recording${retentionPreview.files === 1 ? "" : "s"} (${formatBytes(retentionPreview.bytes)} freed).`}
          </p>
        )}
      </section>

      {/* Backup */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Backup</h3>
        <p className="text-xs text-text-muted mb-3">Export your data or find it on disk.</p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleArchive}
            disabled={archiving}
            className={primarySettingsButtonClass}
          >
            {archiving ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            Full backup (.perchnote)
          </button>
          <button
            onClick={handleBackup}
            className={secondarySettingsButtonClass}
          >
            <Download size={14} />
            Export JSON
          </button>
          <button
            onClick={handleRevealDataFolder}
            className={secondarySettingsButtonClass}
          >
            <FolderOpen size={14} />
            Reveal data folder
          </button>
        </div>
        <p className="text-xs text-text-muted mt-2">
          Full backup bundles your database, recordings, and attachments into one
          checksum-verified archive on your Desktop. Everything stays on this Mac.
        </p>
        <div className="mt-3">
          {!showRestore ? (
            <button
              onClick={() => setShowRestore(true)}
              className={secondarySettingsButtonClass}
            >
              <ArchiveRestore size={14} />
              Restore from backup…
            </button>
          ) : backupArchives.length === 0 ? (
            <p className="text-xs text-text-muted">
              No .perchnote archives found on your Desktop, Documents, or Downloads.
            </p>
          ) : (
            <ul className="space-y-1 list-none p-0 m-0" aria-label="Backup archives">
              {backupArchives.slice(0, 5).map((b) => (
                <li key={b.path}>
                  <button
                    onClick={() => setRestoreTarget(b)}
                    disabled={restoring}
                    className="flex w-full items-baseline gap-3 rounded-lg border border-border px-3 py-2 text-left hover:bg-bg-hover disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                      {b.path.split("/").pop()}
                    </span>
                    <span className="text-xs shrink-0 text-text-muted">
                      {formatBytes(b.bytes)} · {b.modified.slice(0, 10)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Markdown mirror */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Markdown Mirror</h3>
        <label className="flex items-start gap-2.5 cursor-pointer mb-2">
          <input
            type="checkbox"
            checked={mdMirror === "true"}
            onChange={(e) => handleMdMirrorChange(e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span className="text-xs text-text-muted">
            Keep a Markdown copy of every meeting's notes in Documents/Perchnote:
            plain files that iCloud, git, or Obsidian can pick up. Notes mirror
            when they're enhanced; use Sync all for everything at once.
          </span>
        </label>
        {mdMirror === "true" && (
          <div className="space-y-2">
            <label className="block">
              <span className="text-xs text-text-muted">
                Folder layout. Existing files move to the new spot the next
                time their notes save; Sync all applies it to everything now.
              </span>
              <select
                value={mirrorLayout}
                onChange={(e) => handleMirrorLayoutChange(e.target.value)}
                className={`${settingsInputClass} mt-1 w-full`}
              >
                <option value="flat">All in one folder</option>
                <option value="monthly">By month (2026/06)</option>
                <option value="by-folder">By meeting folder</option>
              </select>
            </label>
            <button
              onClick={handleSyncAllMd}
              disabled={syncingMd}
              className={secondarySettingsButtonCompactClass}
            >
              {syncingMd ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
              Sync all notes now
            </button>
          </div>
        )}
      </section>

      {/* Auto-archive (this only HIDES old meetings from the list — it was
          labeled "Data Retention", implying deletion it never did) */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Auto-archive meetings</h3>
        <p className="text-xs text-text-muted mb-3">
          Move old meetings out of the list automatically. Archiving hides;
          it never deletes anything.
        </p>
        <select
          value={retentionDays}
          onChange={(e) => handleRetentionChange(e.target.value)}
          className={`${settingsInputClass} w-full`}
        >
          <option value="0">Keep meetings forever</option>
          <option value="30">Auto-archive after 30 days</option>
          <option value="60">Auto-archive after 60 days</option>
          <option value="90">Auto-archive after 90 days</option>
          <option value="180">Auto-archive after 180 days</option>
          <option value="365">Auto-archive after 365 days</option>
        </select>
      </section>

      {/* Archived */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Archived</h3>
        <p className="text-xs text-text-muted mb-3">
          {archivedMeetings.length === 0
            ? "No archived meetings. Archiving (including auto-archive above) hides meetings here; nothing is deleted."
            : `${archivedMeetings.length} archived meeting${archivedMeetings.length !== 1 ? "s" : ""}, hidden from the list, fully intact.`}
        </p>
        {archivedMeetings.length > 0 && (
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
            {archivedMeetings.map((m) => (
              <div key={m.id} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-bg-hover">
                <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{m.title}</span>
                <span className="shrink-0 text-footnote text-text-muted">
                  {(m.actual_start ?? m.scheduled_start ?? m.created_at)?.slice(0, 10)}
                </span>
                <button
                  type="button"
                  onClick={() => handleUnarchive(m.id)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-footnote text-accent transition-colors hover:bg-accent/10"
                >
                  Unarchive
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Trash */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Trash</h3>
        <p className="text-xs text-text-muted mb-3">
          {deletedMeetings.length === 0
            ? "Trash is empty."
            : `${deletedMeetings.length} deleted meeting${deletedMeetings.length !== 1 ? "s" : ""}.`}
        </p>
        <select
          value={trashRetention}
          onChange={(e) => handleTrashRetentionChange(e.target.value)}
          aria-label="Automatically clear trash"
          className={`${settingsInputClass} mb-3 w-full`}
        >
          <option value="0">Keep trash until I empty it (default)</option>
          <option value="30">Clear trash after 30 days (meetings, notes, and audio gone for good)</option>
        </select>
        {deletedMeetings.length > 0 && (
          <div className="ios-group mb-3">
            {deletedMeetings.map((m) => (
              <div key={m.id} className="ios-row">
                <Trash2 size={13} className="shrink-0 text-text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text-primary">{m.title}</p>
                  <p className="text-xs text-text-muted">
                    Deleted {m.deleted_at ? new Date(m.deleted_at).toLocaleDateString() : ""}
                    {trashRetention !== "0" && " · auto-removes after 30 days"}
                  </p>
                </div>
                <button
                  onClick={() => handleRestoreOne(m)}
                  className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
                >
                  Restore
                </button>
                <button
                  onClick={() => setConfirmForever(m)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-recording transition-colors hover:bg-recording/10"
                  title="Delete forever: notes, transcript, and audio"
                >
                  Delete forever
                </button>
              </div>
            ))}
          </div>
        )}
        {deletedMeetings.length > 0 && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowEmptyTrash(true)}
              className="btn btn-lg bg-red-500 text-white hover:bg-red-600"
            >
              <Trash2 size={14} />
              Empty trash
            </button>
            <button
              onClick={handleRestoreAll}
              className={secondarySettingsButtonClass}
            >
              <ArchiveRestore size={14} />
              Restore all
            </button>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmForever !== null}
        title="Delete forever"
        message={`Permanently delete “${confirmForever?.title ?? ""}”? Notes, transcript, and audio are removed and cannot be recovered.`}
        confirmLabel="Delete forever"
        variant="danger"
        onConfirm={() => confirmForever && handleDeleteForever(confirmForever)}
        onCancel={() => setConfirmForever(null)}
      />
      <ConfirmDialog
        open={showEmptyTrash}
        title="Empty Trash"
        message={`Permanently delete ${deletedMeetings.length} meeting${deletedMeetings.length !== 1 ? "s" : ""}? This cannot be undone.`}
        confirmLabel="Empty Trash"
        variant="danger"
        onConfirm={handleEmptyTrash}
        onCancel={() => setShowEmptyTrash(false)}
      />
      <ConfirmDialog
        open={restoreTarget !== null}
        title="Restore from backup"
        message={`Replace your current data with “${restoreTarget?.path.split("/").pop() ?? ""}”? The app will verify the archive, keep a copy of your current database, and restart. Recordings not in the backup are kept.`}
        confirmLabel={restoring ? "Restoring…" : "Restore & Restart"}
        variant="danger"
        onConfirm={handleRestore}
        onCancel={() => !restoring && setRestoreTarget(null)}
      />
      <ConfirmDialog
        open={audioDeleteTarget !== null}
        title="Delete this recording's audio"
        message={`Delete the audio file for “${audioDeleteTarget?.title ?? ""}”? The meeting, its notes, and its transcript are kept; only playback goes away. This cannot be undone.`}
        confirmLabel="Delete audio"
        variant="danger"
        onConfirm={handleDeleteAudio}
        onCancel={() => setAudioDeleteTarget(null)}
      />
    </div>
  );
}
