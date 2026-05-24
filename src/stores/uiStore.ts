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
  toggleSidebar: () => void;
  setSidebarCollapsed: (value: boolean) => void;

  // Sidebar view mode
  sidebarView: "timeline" | "people" | "companies" | "folders";
  setSidebarView: (view: "timeline" | "people" | "companies" | "folders") => void;

  // Pending auto-start: set before navigating to a new meeting so MeetingView starts recording on mount
  pendingAutoStart: boolean;
  setPendingAutoStart: (value: boolean) => void;
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
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      try { localStorage.setItem("sidebar-collapsed", String(next)); } catch {}
      return { sidebarCollapsed: next };
    }),
  setSidebarCollapsed: (value: boolean) => {
    try { localStorage.setItem("sidebar-collapsed", String(value)); } catch {}
    set({ sidebarCollapsed: value });
  },

  sidebarView: "timeline",
  setSidebarView: (view) => set({ sidebarView: view }),

  // Not persisted to localStorage — intentionally ephemeral
  pendingAutoStart: false,
  setPendingAutoStart: (value: boolean) => set({ pendingAutoStart: value }),
}));
