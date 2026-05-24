import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Check } from "lucide-react";
import { ipc, Template } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";
import { ConfirmDialog } from "../shared/ConfirmDialog";

export function TemplateSettings() {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({
    queryKey: ["templates"],
    queryFn: ipc.listTemplates,
  });

  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["templates"] });

  const handleSetDefault = async (t: Template) => {
    if (t.is_default) return;
    await ipc.updateTemplate(t.id, t.name, t.description ?? "", t.prompt_template, t.sections, true);
    invalidate();
    toast.success(`"${t.name}" is now the default template`);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await ipc.deleteTemplate(deleteTarget.id);
    invalidate();
    setDeleteTarget(null);
    toast.info("Template deleted");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Note Templates</h2>
          <p className="text-xs text-text-muted mt-0.5">Templates control how AI generates your meeting notes.</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90 transition-opacity"
        >
          <Plus size={13} />
          New Template
        </button>
      </div>

      <div className="space-y-2">
        {templates.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg-secondary hover:bg-bg-hover transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary truncate">{t.name}</span>
                {t.is_default && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent font-medium shrink-0">Default</span>
                )}
                {t.is_builtin && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-muted font-medium shrink-0">Built-in</span>
                )}
              </div>
              {t.description && (
                <p className="text-xs text-text-muted mt-0.5 truncate">{t.description}</p>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {!t.is_default && (
                <button
                  onClick={() => handleSetDefault(t)}
                  title="Set as default"
                  className="p-1.5 rounded-md text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                >
                  <Check size={13} />
                </button>
              )}
              <button
                onClick={() => setEditing(t)}
                title="Edit"
                className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              >
                <Pencil size={13} />
              </button>
              {!t.is_builtin && (
                <button
                  onClick={() => setDeleteTarget(t)}
                  title="Delete"
                  className="p-1.5 rounded-md text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>
        ))}

        {templates.length === 0 && (
          <p className="text-sm text-text-muted text-center py-6">No templates yet.</p>
        )}
      </div>

      {(editing || creating) && (
        <TemplateForm
          initial={editing ?? undefined}
          onSave={async (data) => {
            if (editing) {
              await ipc.updateTemplate(editing.id, data.name, data.description, data.prompt_template, data.sections, data.is_default);
              toast.success("Template saved");
            } else {
              await ipc.createTemplate(data.name, data.description, data.prompt_template, data.sections, data.is_default);
              toast.success("Template created");
            }
            invalidate();
            setEditing(null);
            setCreating(false);
          }}
          onCancel={() => { setEditing(null); setCreating(false); }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Template"
        message={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

interface FormData {
  name: string;
  description: string;
  prompt_template: string;
  sections: string;
  is_default: boolean;
}

function TemplateForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Template;
  onSave: (data: FormData) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [promptTemplate, setPromptTemplate] = useState(initial?.prompt_template ?? "");
  const [sections] = useState(initial?.sections ?? "[]");
  const [isDefault, setIsDefault] = useState(initial?.is_default ?? false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), description: description.trim(), prompt_template: promptTemplate, sections, is_default: isDefault });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-4 bg-bg-secondary">
      <h3 className="text-sm font-semibold text-text-primary">{initial ? "Edit Template" : "New Template"}</h3>

      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:border-accent"
            placeholder="e.g. Weekly Standup"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1">Description <span className="text-text-muted font-normal">(optional)</span></label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:border-accent"
            placeholder="Brief description of when to use this template"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1">AI Prompt</label>
          <textarea
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
            rows={6}
            className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border text-sm text-text-primary font-mono focus:outline-none focus:border-accent resize-none"
            placeholder="Instructions for the AI when generating notes for this template..."
          />
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="w-4 h-4 shrink-0 accent-accent"
          />
          <span className="text-sm text-text-secondary">Set as default template</span>
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
