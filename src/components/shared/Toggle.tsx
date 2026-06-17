export function Toggle({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean;
  onChange: () => void;
  /** Accessible name — REQUIRED for screen readers (deep review: seven
   *  Audio settings were blank unlabeled buttons to VoiceOver). */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onChange}
      className={`relative flex-shrink-0 w-10 h-6 rounded-full overflow-hidden transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
        enabled ? "bg-accent" : "bg-bg-tertiary border border-border"
      }`}
    >
      <span
        className={`absolute top-1 left-0 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
          enabled ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  );
}
