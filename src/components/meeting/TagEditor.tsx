import { useState, useRef, useEffect } from "react";
import { X, Plus, Tag } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ipc, Tag as TagType } from "../../lib/ipc";
import { toast } from "../../stores/toastStore";

interface TagEditorProps {
  meetingId: string;
  onEditingChange?: (isEditing: boolean) => void;
}

export function TagEditor({ meetingId, onEditingChange }: TagEditorProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: meetingTags = [] } = useQuery({
    queryKey: ["meetingTags", meetingId],
    queryFn: () => ipc.getMeetingTags(meetingId),
  });

  const { data: allTags = [] } = useQuery({
    queryKey: ["tags"],
    queryFn: ipc.listTags,
  });

  useEffect(() => {
    if (isAdding) inputRef.current?.focus();
  }, [isAdding]);

  useEffect(() => {
    onEditingChange?.(isAdding);
  }, [isAdding, onEditingChange]);

  const meetingTagIds = new Set(meetingTags.map((t) => t.id));

  // Filter suggestions: existing tags not already on this meeting, matching input
  const suggestions = allTags
    .filter((t) => !meetingTagIds.has(t.id))
    .filter((t) =>
      inputValue ? t.name.toLowerCase().includes(inputValue.toLowerCase()) : true
    )
    .slice(0, 8);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["meetingTags", meetingId] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  };

  const handleAddTag = async (tag: TagType) => {
    await ipc.addTagToMeeting(meetingId, tag.id);
    invalidate();
    setInputValue("");
    setIsAdding(false);
  };

  const handleCreateAndAdd = async () => {
    const name = inputValue.trim();
    if (!name) return;

    // Check if tag already exists
    const existing = allTags.find(
      (t) => t.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      if (meetingTagIds.has(existing.id)) {
        toast.info("Tag already added to this meeting");
        return;
      }
      await handleAddTag(existing);
      return;
    }

    const newTag = await ipc.createTag(name);
    await ipc.addTagToMeeting(meetingId, newTag.id);
    invalidate();
    setInputValue("");
    setIsAdding(false);
    toast.success(`Tag "${name}" created`);
  };

  const handleRemoveTag = async (tagId: string) => {
    await ipc.removeTagFromMeeting(meetingId, tagId);
    invalidate();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCreateAndAdd();
    }
    if (e.key === "Escape") {
      setIsAdding(false);
      setInputValue("");
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {meetingTags.map((tag) => (
        <span
          key={tag.id}
          className="group inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent focus-within:ring-1 focus-within:ring-accent/40"
        >
          <Tag size={10} />
          {/* Tags read path: the name is the way IN to "everything with
              this tag" — it used to be inert (deep review P2). */}
          <button
            type="button"
            onClick={() => navigate({ to: "/meetings", search: { tag: tag.name } })}
            className="max-w-[140px] truncate hover:underline"
            title={`Show all meetings tagged “${tag.name}”`}
          >
            {tag.name}
          </button>
          <button
            type="button"
            onClick={() => handleRemoveTag(tag.id)}
            className="ml-0.5 rounded opacity-0 transition-opacity hover:text-recording focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            title="Remove tag"
            aria-label={`Remove ${tag.name} tag`}
          >
            <X size={12} />
          </button>
        </span>
      ))}

      {isAdding ? (
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setShowSuggestions(true);
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Delay to allow clicking suggestions
              setTimeout(() => {
                setShowSuggestions(false);
                if (!inputValue) setIsAdding(false);
              }, 300);
            }}
            onFocus={() => setShowSuggestions(true)}
            placeholder="Tag name…"
            className="w-32 px-2 py-0.5 text-xs rounded-full bg-bg-tertiary text-text-primary border border-accent focus:outline-none"
          />
          {showSuggestions && suggestions.length > 0 && (
            <div className="glass-float menu-dropdown-left absolute top-full left-0 mt-1 w-48 rounded-lg z-10 py-1 max-h-40 overflow-y-auto">
              {suggestions.map((tag) => (
                <button
                  type="button"
                  key={tag.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleAddTag(tag)}
                  className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                >
                  {tag.name}
                </button>
              ))}
              {inputValue && !suggestions.find((s) => s.name.toLowerCase() === inputValue.toLowerCase()) && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleCreateAndAdd}
                  className="w-full text-left px-3 py-1.5 text-xs text-accent hover:bg-bg-hover transition-colors border-t border-border"
                >
                  Create "{inputValue}"
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsAdding(true)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors border border-dashed border-border"
          title="Add tag"
        >
          <Plus size={10} />
          Tag
        </button>
      )}
    </div>
  );
}
