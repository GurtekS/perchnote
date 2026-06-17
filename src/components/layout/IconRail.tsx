import { useNavigate, useMatchRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { LayoutList, Folder, Search, Sparkles, Settings, CalendarDays, ListChecks, ChevronLeft, ChevronRight, TrendingUp , PanelLeft } from "lucide-react";
import { useUIStore, isMeetingListHidden } from "../../stores/uiStore";
import perchnoteIcon from "../../assets/perchnote-icon.png";

export function IconRail() {
  const navigate = useNavigate();
  const router = useRouter();
  const matchRoute = useMatchRoute();
  const toggleAskAI = useUIStore((s) => s.toggleAskAI);
  // Real panel visibility (same computation the layout uses), so the ⌘B
  // toggle below can expose honest aria-expanded state and a label that
  // says which way it will flip — not the ambiguous "Show/hide".
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const focusMode = useUIStore((s) => s.focusMode);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const sidebarUserToggled = useUIStore((s) => s.sidebarUserToggled);
  const meetingListVisible = !isMeetingListHidden(currentPath, {
    focusMode,
    sidebarCollapsed,
    sidebarUserToggled,
  });

  const isMeetings =
    !!matchRoute({ to: "/" }) ||
    !!matchRoute({ to: "/meetings" }) ||
    !!matchRoute({ to: "/meeting/$id", fuzzy: true });
  const isFolders =
    !!matchRoute({ to: "/folders" }) ||
    !!matchRoute({ to: "/folders/$folderId", fuzzy: true });
  const isCalendar = !!matchRoute({ to: "/calendar" });
  const isInsights = !!matchRoute({ to: "/insights" });
  const isTasks = !!matchRoute({ to: "/tasks" });
  const isSettings = !!matchRoute({ to: "/settings" });

  function handleSearchClick() {
    // Open the CommandPalette — full-document search across titles,
    // transcripts and notes, far more capable than the sidebar list
    // filter. Same surface as ⌘K; this just exposes it to mouse users.
    document.dispatchEvent(new CustomEvent("open-command-palette"));
  }

  return (
    <aside
      className="w-[56px] h-full flex flex-col items-center py-3 gap-1.5 shrink-0"
      style={{
        background: "var(--glass-rail-bg)",
        borderRight: "1px solid var(--glass-rail-border)",
      }}
    >
      {/* App icon */}
      <button
        onClick={() => navigate({ to: "/" })}
        className="w-7 h-7 rounded-[7px] mb-3 flex items-center justify-center shrink-0 overflow-hidden"
        style={{
          boxShadow: "0 0 14px rgba(var(--accent-rgb), 0.35)",
        }}
        title="Home"
        aria-label="Home"
      >
        <img src={perchnoteIcon} alt="" className="w-full h-full object-cover" draggable={false} />
      </button>

      {/* History pathing — visible back/forward so deep links (task →
          meeting, search hit, calendar event) are round trips. ⌘[ / ⌘] */}
      <div className="flex items-center gap-0.5 mb-2">
        <button
          onClick={() => router.history.back()}
          title="Back (⌘[)"
          aria-label="Back"
          className="w-[18px] h-[22px] flex items-center justify-center rounded-md transition-colors"
          style={{ color: "var(--icon-color-dim)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--icon-color-bright)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--icon-color-dim)"; }}
        >
          <ChevronLeft size={13} />
        </button>
        <button
          onClick={() => router.history.forward()}
          title="Forward (⌘])"
          aria-label="Forward"
          className="w-[18px] h-[22px] flex items-center justify-center rounded-md transition-colors"
          style={{ color: "var(--icon-color-dim)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--icon-color-bright)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--icon-color-dim)"; }}
        >
          <ChevronRight size={13} />
        </button>
      </div>

      {/* Hairline between chrome (logo/history) and the nav stack — the
          unseparated pile read as misalignment (user: "navigation looks
          off"). */}
      <div
        className="mb-1.5 h-px w-5 shrink-0"
        style={{ background: "var(--glass-rail-border)" }}
      />

      <RailIcon
        icon={<LayoutList size={16} />}
        label="Meetings (⌘1)"
        active={isMeetings}
        onClick={() => navigate({ to: "/" })}
      />
      <RailIcon
        icon={<ListChecks size={16} />}
        label="Tasks (⌘2)"
        active={isTasks}
        onClick={() => navigate({ to: "/tasks" })}
      />
      <RailIcon
        icon={<Folder size={16} />}
        label="Folders (⌘3)"
        active={isFolders}
        onClick={() => navigate({ to: "/folders" })}
      />
      <RailIcon
        icon={<CalendarDays size={16} />}
        label="Calendar (⌘4)"
        active={isCalendar}
        onClick={() => navigate({ to: "/calendar" })}
      />
      <RailIcon
        icon={<TrendingUp size={16} />}
        label="Insights (⌘5)"
        active={isInsights}
        onClick={() => navigate({ to: "/insights" })}
      />
      <RailIcon
        icon={<Search size={16} />}
        label="Search (⌘K)"
        active={false}
        onClick={handleSearchClick}
      />

      <div className="flex-1" />

      <RailIcon
        id="rail-toggle-meeting-list"
        icon={<PanelLeft size={16} />}
        label={meetingListVisible ? "Hide meeting list (⌘B)" : "Show meeting list (⌘B)"}
        active={false}
        expanded={meetingListVisible}
        onClick={() => useUIStore.getState().toggleSidebar()}
      />
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
  id,
  expanded,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  /** Stable id so dismissal handlers can park focus here (e.g. the meeting
   *  list's hide chevron unmounts with its panel). */
  id?: string;
  /** For toggles that control a collapsible panel: aria-expanded state. */
  expanded?: boolean;
}) {
  return (
    <button
      id={id}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
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
