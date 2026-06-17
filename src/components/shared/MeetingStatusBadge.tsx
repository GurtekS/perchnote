interface MeetingStatusBadgeProps {
  status: "none" | "draft" | "enhanced";
  className?: string;
}

export function MeetingStatusBadge({ status, className = "" }: MeetingStatusBadgeProps) {
  if (status === "none") return null;

  if (status === "enhanced") {
    return (
      <span
        title="AI enhanced"
        className={`text-[9px] leading-none select-none ${className}`}
        style={{ color: "var(--color-accent)" }}
      >
        ✦
      </span>
    );
  }

  // draft
  return (
    <span
      title="Has notes"
      className={`dot-glow inline-block w-1.5 h-1.5 rounded-full shrink-0 ${className}`}
      style={{ background: "var(--color-accent)", color: "var(--color-accent)", opacity: 0.7 }}
    />
  );
}
