import { useNavigate, useMatchRoute } from "@tanstack/react-router";
import { LayoutList, Folder, Search, Sparkles, Settings, CalendarDays } from "lucide-react";
import { useUIStore } from "../../stores/uiStore";

export function IconRail() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const toggleAskAI = useUIStore((s) => s.toggleAskAI);

  const isMeetings =
    !!matchRoute({ to: "/" }) || !!matchRoute({ to: "/meeting/$id", fuzzy: true });
  const isFolders =
    !!matchRoute({ to: "/folders" }) ||
    !!matchRoute({ to: "/folders/$folderId", fuzzy: true });
  const isCalendar = !!matchRoute({ to: "/calendar" });
  const isSettings = !!matchRoute({ to: "/settings" });

  function handleSearchClick() {
    // Open the CommandPalette — full-document search across titles,
    // transcripts and notes, far more capable than the sidebar list
    // filter. Same surface as ⌘K; this just exposes it to mouse users.
    document.dispatchEvent(new CustomEvent("open-command-palette"));
  }

  return (
    <aside
      className="w-[52px] h-full flex flex-col items-center py-3 gap-1 shrink-0"
      style={{
        background: "var(--glass-rail-bg)",
        borderRight: "1px solid var(--glass-rail-border)",
      }}
    >
      {/* App icon */}
      <button
        onClick={() => navigate({ to: "/" })}
        className="w-7 h-7 rounded-[7px] mb-3 flex items-center justify-center shrink-0"
        style={{
          background: "linear-gradient(135deg, var(--accent) 0%, rgba(139,92,246,0.8) 100%)",
          boxShadow: "0 0 14px rgba(var(--accent-rgb), 0.35)",
        }}
        title="Home"
        aria-label="Home"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="2" y="4" width="10" height="7" rx="2" stroke="white" strokeWidth="1.3" strokeOpacity="0.9"/>
          <circle cx="7" cy="7.5" r="1.5" fill="white" fillOpacity="0.9"/>
          <path d="M5 2.5 L7 1 L9 2.5" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.7"/>
        </svg>
      </button>

      <RailIcon
        icon={<LayoutList size={16} />}
        label="Meetings"
        active={isMeetings}
        onClick={() => navigate({ to: "/" })}
      />
      <RailIcon
        icon={<Folder size={16} />}
        label="Folders"
        active={isFolders}
        onClick={() => navigate({ to: "/folders" })}
      />
      <RailIcon
        icon={<CalendarDays size={16} />}
        label="Calendar"
        active={isCalendar}
        onClick={() => navigate({ to: "/calendar" })}
      />
      <RailIcon
        icon={<Search size={16} />}
        label="Search (⌘K)"
        active={false}
        onClick={handleSearchClick}
      />

      <div className="flex-1" />

      <RailIcon
        icon={<Sparkles size={16} />}
        label="Ask AI (⌘J)"
        active={false}
        onClick={toggleAskAI}
      />
      <RailIcon
        icon={<Settings size={16} />}
        label="Settings (⌘,)"
        active={isSettings}
        onClick={() => navigate({ to: "/settings" })}
      />
    </aside>
  );
}

function RailIcon({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className="w-[34px] h-[34px] rounded-[9px] flex items-center justify-center transition-all duration-150"
      style={
        active
          ? {
              background: "rgba(var(--accent-rgb), 0.15)",
              border: "1px solid rgba(var(--accent-rgb), 0.3)",
              boxShadow: "0 0 12px rgba(var(--accent-rgb), 0.12)",
              color: "var(--accent)",
            }
          : {
              color: "var(--icon-color-dim)",
              border: "1px solid transparent",
            }
      }
      onMouseEnter={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--icon-hover-bg)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--icon-color-bright)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = "";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--icon-color-dim)";
        }
      }}
    >
      {icon}
    </button>
  );
}
