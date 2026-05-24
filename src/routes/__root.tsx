import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { IconRail } from "../components/layout/IconRail";
import { MeetingListPanel } from "../components/layout/MeetingListPanel";
import { OnboardingFlow } from "../components/settings/OnboardingFlow";
import { useOnboarding } from "../hooks/useOnboarding";
import { initRecordingListeners } from "../stores/recordingStore";
import { useUIStore } from "../stores/uiStore";
import { toast } from "../stores/toastStore";
import { ipc } from "../lib/ipc";
import { AskAIOverlay } from "../components/meeting/AskAIOverlay";
import { CommandPalette } from "../components/shared/CommandPalette";
import { isTauriRuntime } from "../lib/runtime";
import {
  checkThresholdAndBegin,
  updateDragPosition,
  getDraggingMeetingId,
  endDrag,
} from "../lib/meetingDrag";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { isComplete, isLoading, completeOnboarding } = useOnboarding();
  const focusMode = useUIStore((s) => s.focusMode);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const askAIOpen = useUIStore((s) => s.askAIOpen);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const browserPath = typeof window !== "undefined" ? window.location.pathname : currentPath;
  const isOnboardingPreviewRoute = currentPath === "/onboarding" || browserPath === "/onboarding";

  const handleCompleteOnboarding = useCallback(async () => {
    await completeOnboarding();
    await navigate({ to: "/" });
  }, [completeOnboarding, navigate]);

  // Extract current meeting ID from route if on a meeting page
  const currentMeetingId = (() => {
    const match = routerState.matches.find((m) => m.routeId === "/meeting/$id");
    return (match?.params as { id?: string })?.id ?? null;
  })();

  useEffect(() => {
    initRecordingListeners();
  }, []);

  // NOTE: Auto-focus-mode-on-recording intentionally removed.
  // The MeetingListPanel stays visible during recording so MeetingBanner quick-stop works.
  // Users can still manually toggle focus mode via Cmd+\.

  // Create new meeting helper
  const createNewMeeting = useCallback(async () => {
    try {
      const dateStr = new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
      }).format(new Date());
      const m = await ipc.createMeeting(`Meeting — ${dateStr}`);
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      useUIStore.getState().setPendingAutoStart(true);
      navigate({ to: "/meeting/$id", params: { id: m.id } });
    } catch {
      // Failed to create meeting
    }
  }, [navigate, queryClient]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key === "n") { e.preventDefault(); createNewMeeting(); }
      if (meta && e.key === "b") { e.preventDefault(); useUIStore.getState().toggleSidebar(); }
      if (meta && e.key === "j") { e.preventDefault(); useUIStore.getState().toggleAskAI(); }
      if (meta && e.key === "t") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("open-transcript-drawer"));
      }
      if (meta && e.key === ",") { e.preventDefault(); navigate({ to: "/settings" }); }
      if (meta && e.key === "k") { e.preventDefault(); }
      if (meta && e.key === "f") {
        e.preventDefault();
        const state = useUIStore.getState();
        if (state.sidebarCollapsed) state.toggleSidebar();
        document.dispatchEvent(new CustomEvent("focus-meeting-search"));
      }
      if (meta && e.shiftKey && e.key === "F") { e.preventDefault(); navigate({ to: "/" }); }
      if (meta && e.key === "\\") { e.preventDefault(); useUIStore.getState().toggleFocusMode(); }
      if (meta && e.key === "/") { e.preventDefault(); }
      if (meta && e.key === "Backspace") { e.preventDefault(); }
      if (e.key === "Escape") {
        const state = useUIStore.getState();
        if (state.askAIOpen) useUIStore.getState().toggleAskAI();
        // transcriptDrawerOpen is now local state in MeetingView
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createNewMeeting, navigate]);

  // Global pointer-based meeting drag-and-drop
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      checkThresholdAndBegin(e.clientX, e.clientY);
      if (getDraggingMeetingId()) {
        updateDragPosition(e.clientX, e.clientY);
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const target = el?.closest("[data-folder-drop]");
        document.dispatchEvent(new CustomEvent("meeting-drag-over", {
          detail: { folderId: target?.getAttribute("data-folder-drop") ?? null },
        }));
      }
    };
    const onUp = async (e: PointerEvent) => {
      const meetingId = endDrag();
      document.dispatchEvent(new CustomEvent("meeting-drag-over", { detail: { folderId: null } }));
      if (!meetingId) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const target = el?.closest("[data-folder-drop]");
      const folderId = target?.getAttribute("data-folder-drop");
      if (folderId) {
        try {
          await ipc.addMeetingToFolder(meetingId, folderId);
          queryClient.invalidateQueries({ queryKey: ["meetings"] });
          queryClient.invalidateQueries({ queryKey: ["folders"] });
          queryClient.invalidateQueries({ queryKey: ["folderMeetings", folderId] });
        } catch {}
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [queryClient]);

  // macOS application menu event listeners
  useEffect(() => {
    if (!isTauriRuntime()) return;

    const subs = [
      listen("menu-new-meeting", () => createNewMeeting()),
      listen("menu-preferences", () => navigate({ to: "/settings" })),
      listen("menu-toggle-sidebar", () => useUIStore.getState().toggleSidebar()),
      listen("menu-toggle-focus", () => useUIStore.getState().toggleFocusMode()),
      listen("menu-ask-ai", () => useUIStore.getState().toggleAskAI()),
      listen<string>("recording-warning", (e) => toast.warning(e.payload)),
      listen<string>("open-meeting", (e) => {
        navigate({ to: "/meeting/$id", params: { id: e.payload } });
      }),
    ];
    return () => { subs.forEach((p) => p.then((fn) => fn())); };
  }, [createNewMeeting, navigate]);

  if (isLoading && !isOnboardingPreviewRoute) return null;
  if (!isComplete && !isOnboardingPreviewRoute) {
    return <OnboardingFlow onComplete={handleCompleteOnboarding} />;
  }
  if (isOnboardingPreviewRoute) return <Outlet />;

  // Hide meeting list panel when: focus mode, sidebar collapsed, or on folders/settings routes
  const hideMeetingList =
    focusMode ||
    sidebarCollapsed ||
    currentPath.startsWith("/folders") ||
    currentPath === "/settings";

  return (
    <div className="h-screen flex overflow-hidden app-shell-glow" style={{ background: "var(--color-bg-primary)", color: "var(--color-text-primary)" }}>
      {/* Icon rail — always visible */}
      <IconRail />

      {/* Meeting list panel — conditionally visible */}
      {!hideMeetingList && (
        <div className="hidden md:contents">
          <MeetingListPanel />
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>

      <AskAIOverlay
        meetingId={currentMeetingId}
        isOpen={askAIOpen}
        onClose={() => useUIStore.getState().toggleAskAI()}
      />

      {/* CommandPalette lives here (not App.tsx) so router hooks like
          useMatchRoute have access to RouterProvider's context. */}
      <CommandPalette />
    </div>
  );
}
