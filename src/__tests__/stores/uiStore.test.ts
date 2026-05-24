import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "../../stores/uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    useUIStore.setState({
      focusMode: false,
      transcriptDrawerOpen: false,
      askAIOpen: false,
      sidebarCollapsed: false,
      sidebarView: "timeline",
    });
  });

  it("initializes with default state", () => {
    const state = useUIStore.getState();
    expect(state.focusMode).toBe(false);
    expect(state.transcriptDrawerOpen).toBe(false);
    expect(state.askAIOpen).toBe(false);
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.sidebarView).toBe("timeline");
  });

  it("toggleFocusMode flips focusMode", () => {
    useUIStore.getState().toggleFocusMode();
    expect(useUIStore.getState().focusMode).toBe(true);
    useUIStore.getState().toggleFocusMode();
    expect(useUIStore.getState().focusMode).toBe(false);
  });

  it("setFocusMode sets a specific value", () => {
    useUIStore.getState().setFocusMode(true);
    expect(useUIStore.getState().focusMode).toBe(true);
    useUIStore.getState().setFocusMode(false);
    expect(useUIStore.getState().focusMode).toBe(false);
  });

  it("toggleTranscriptDrawer flips transcriptDrawerOpen", () => {
    useUIStore.getState().toggleTranscriptDrawer();
    expect(useUIStore.getState().transcriptDrawerOpen).toBe(true);
    useUIStore.getState().toggleTranscriptDrawer();
    expect(useUIStore.getState().transcriptDrawerOpen).toBe(false);
  });

  it("toggleAskAI flips askAIOpen", () => {
    useUIStore.getState().toggleAskAI();
    expect(useUIStore.getState().askAIOpen).toBe(true);
    useUIStore.getState().toggleAskAI();
    expect(useUIStore.getState().askAIOpen).toBe(false);
  });

  it("toggleSidebar flips sidebarCollapsed", () => {
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it("setSidebarView changes the active view", () => {
    useUIStore.getState().setSidebarView("folders");
    expect(useUIStore.getState().sidebarView).toBe("folders");
    useUIStore.getState().setSidebarView("people");
    expect(useUIStore.getState().sidebarView).toBe("people");
  });

  it("all sidebar views are valid", () => {
    const views = ["timeline", "people", "companies", "folders"] as const;
    for (const view of views) {
      useUIStore.getState().setSidebarView(view);
      expect(useUIStore.getState().sidebarView).toBe(view);
    }
  });

  it("independent state fields do not affect each other", () => {
    useUIStore.getState().toggleFocusMode(); // focusMode = true
    expect(useUIStore.getState().transcriptDrawerOpen).toBe(false); // unaffected
    expect(useUIStore.getState().askAIOpen).toBe(false); // unaffected
  });
});
