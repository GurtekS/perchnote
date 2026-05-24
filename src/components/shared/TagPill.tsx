interface TagPillProps {
  name: string;
  onRemove?: () => void;
  onClick?: () => void;
}

export function TagPill({ name, onRemove, onClick }: TagPillProps) {
  return (
    <span
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-bg-tertiary text-text-secondary ${
        onClick ? "cursor-pointer hover:bg-bg-hover" : ""
      }`}
    >
      {name}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="hover:text-text-primary"
        >
          ×
        </button>
      )}
    </span>
  );
}
