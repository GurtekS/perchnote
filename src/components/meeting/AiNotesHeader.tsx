interface Props {
  tags: string[];
}

export function AiNotesHeader({ tags }: Props) {
  const cleaned = tags.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 mb-3 list-none p-0" aria-label="Meeting tags">
      {cleaned.map((tag) => (
        <li
          key={tag}
          className="text-caption font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}
