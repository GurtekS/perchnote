import type { FilterChip } from "../../lib/searchFilterHints";

/**
 * Filter-grammar chips (plan v8 A3): one feedback affordance for the
 * speaker:/folder:/before:/after: grammar everywhere it can be typed —
 * the command palette and the recipe scope field render the same chips,
 * with malformed dates flagged as ignored instead of silently dropped.
 */
export function FilterChips({
  chips,
  className = "",
}: {
  chips: FilterChip[];
  className?: string;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 ${className}`}
      data-testid="filter-chips"
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.valid ? `Filtering by ${chip.key}` : "Ignored — dates must be YYYY-MM-DD"}
          className={`inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-footnote ${
            chip.valid ? "text-text-secondary" : "text-text-muted line-through"
          }`}
        >
          <span className="font-semibold">{chip.key}:</span> {chip.value}
          {!chip.valid && <span className="no-underline"> · ignored</span>}
        </span>
      ))}
    </div>
  );
}
