import { create } from "zustand";

interface UIStore {
  // Zen mode -- hides sidebar for distraction-free editing
  focusMode: boolean;
  toggleFocusMode: () => void;
  setFocusMode: (value: boolean) => void;

  // Transcript drawer (right-side panel)
  transcriptDrawerOpen: boolean;
  toggleTranscriptDrawer: () => void;

  // Ask AI overlay (Cmd+J)
  askAIOpen: boolean;
  toggleAskAI: () => void;

  // Collapsible sidebar
  sidebarCollapsed: boolean;
  /** True once the user deliberately toggled the panel this session — the
   *  home route defaults the panel hidden (it duplicates home's own list,
   *  UI review) until the user expresses a preference. */
  sidebarUserToggled: boolean;
  showSidebar: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (value: boolean) => void;

  // Sidebar view mode
  sidebarView: "timeline" | "people" | "companies" | "folders";
  setSidebarView: (view: "timeline" | "people" | "companies" | "folders") => void;

  // Pending auto-start: armed with the TARGET meeting id before navigating,
  // consumed by MeetingView only when it is showing that exact meeting. A
  // bare boolean could dangle forever when the setter targeted the meeting
  // already on screen (no meetingId change → never consumed) and then fire
  // a phantom recording on a later, unrelated navigation (live report:
  // "recording started again after enhance").
  pendingAutoStart: string | null;
  setPendingAutoStart: (meetingId: string | null) => void;

  // Pending auto-enhance: set before navigating so MeetingView triggers the
  // enhance flow on mount (one-click Enhance from list cards)
  pendingAutoEnhance: boolean;
  setPendingAutoEnhance: (value: boolean) => void;

  // Instant recap in flight: the meeting id whose notes the background
  // auto-enhance (run from __root, not the meeting's enhance machine) is
  // currently generating, or null. The post-recording screen reads this so
  // it can show "Generating your notes…" instead of a manual Enhance button
  // that would re-run the same work — the machine's isEnhancing never sees
  // the auto path.
  autoEnhancingMeetingId: string | null;
  setAutoEnhancingMeetingId: (meetingId: string | null) => void;

  // Pending audio seek: set before navigating so MeetingView opens the
  // transcript drawer at that moment (search → jump to the cited moment).
  // Keyed by meeting so a handoff whose navigation never lands (deleted
  // meeting, failed route) can't replay in the next meeting opened. Single
  // slot: the next setPendingSeek overwrites any stale entry.
  pendingSeek: { meetingId: string; ms: number } | null;
  setPendingSeek: (meetingId: string, ms: number) => void;
  clearPendingSeek: () => void;

  // Pending palette query: set by deep links (perchnote://search?q=) —
  // CommandPalette consumes it, opening pre-filled as if the user typed it
  pendingPaletteQuery: string | null;
  setPendingPaletteQuery: (value: string | null) => void;

  // Auto-run recipe output (plan v10 #8): one transient card per session,
  // written by the meeting-completed listener, rendered in the meeting's
  // notes surface, gone on dismiss or app restart. Never persisted —
  // recipe output is "copy what you need", same stance as manual runs.
  recipeCard: { meetingId: string; recipeName: string; text: string } | null;
  setRecipeCard: (card: { meetingId: string; recipeName: string; text: string }) => void;
  dismissRecipeCard: () => void;
}

/**
 * Single source of truth for whether the meeting-list panel is hidden.
 * Used by __root.tsx (to mount/unmount the panel) and IconRail (so the ⌘B
 * rail toggle's aria-expanded/label reflect the real panel state). Hidden
 * when: focus mode, sidebar collapsed, folders/settings routes — or on home
 * BY DEFAULT (it shows the same meetings itself; UI review). A deliberate
 * ⌘B/toggle this session wins.
 */
export function isMeetingListHidden(
  currentPath: string,
  s: Pick<UIStore, "focusMode" | "sidebarCollapsed" | "sidebarUserToggled">,
): boolean {
  return (
    s.focusMode ||
    s.sidebarCollapsed ||
    (currentPath === "/" && !s.sidebarUserToggled && !s.sidebarCollapsed) ||
    currentPath.startsWith("/folders") ||
    currentPath === "/settings"
  );
}

export const useUIStore = create<UIStore>((set) => ({
  focusMode: false,
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  setFocusMode: (value) => set({ focusMode: value }),

  transcriptDrawerOpen: false,
  toggleTranscriptDrawer: () =>
    set((s) => ({ transcriptDrawerOpen: !s.transcriptDrawerOpen })),

  askAIOpen: false,
  toggleAskAI: () => set((s) => ({ askAIOpen: !s.askAIOpen })),

  // Init from localStorage so panel state survives reload
  sidebarCollapsed: (() => {
    try { return localStorage.getItem("sidebar-collapsed") === "true"; }
    catch { return false; }
  })(),
  sidebarUserToggled: false,
  showSidebar: () => {
    try { localStorage.setItem("sidebar-collapsed", "false"); } catch {}
    set({ sidebarCollapsed: false, sidebarUserToggled: true });
  },
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      try { localStorage.setItem("sidebar-collapsed", String(next)); } catch {}
      return { sidebarCollapsed: next, sidebarUserToggled: true };
    }),
  setSidebarCollapsed: (value: boolean) => {
    try { localStorage.setItem("sidebar-collapsed", String(value)); } catch {}
    set({ sidebarCollapsed: value });
  },

  sidebarView: "timeline",
  setSidebarView: (view) => set({ sidebarView: view }),

  // Not persisted to localStorage — intentionally ephemeral
  pendingAutoStart: null,
  setPendingAutoStart: (meetingId: string | null) => set({ pendingAutoStart: meetingId }),

  pendingAutoEnhance: false,
  setPendingAutoEnhance: (value: boolean) => set({ pendingAutoEnhance: value }),

  autoEnhancingMeetingId: null,
  setAutoEnhancingMeetingId: (meetingId: string | null) =>
    set({ autoEnhancingMeetingId: meetingId }),

  pendingSeek: null,
  setPendingSeek: (meetingId: string, ms: number) => set({ pendingSeek: { meetingId, ms } }),
  clearPendingSeek: () => set({ pendingSeek: null }),

  pendingPaletteQuery: null,
  setPendingPaletteQuery: (value: string | null) => set({ pendingPaletteQuery: value }),

  recipeCard: null,
  setRecipeCard: (card) => set({ recipeCard: card }),
  dismissRecipeCard: () => set({ recipeCard: null }),
}));
