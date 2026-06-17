import { createRootRoute, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { IconRail } from "../components/layout/IconRail";
import { KeyboardShortcutsHelp } from "../components/shared/KeyboardShortcutsHelp";
import { MeetingListPanel } from "../components/layout/MeetingListPanel";
import { OnboardingFlow } from "../components/settings/OnboardingFlow";
import { useOnboarding } from "../hooks/useOnboarding";
import { initRecordingListeners, useRecordingStore } from "../stores/recordingStore";
import { useUIStore, isMeetingListHidden } from "../stores/uiStore";
import { toast } from "../stores/toastStore";
import { toUserMessage } from "../lib/errors";
import { ipc } from "../lib/ipc";
import { createQuickVoiceNote } from "../lib/quickNote";
import { dispatchDeepAction, type DeepActionWire } from "../lib/deepActions";
import { runEnhance } from "../lib/enhance";
import { scheduleMirror } from "../lib/mirrorLifecycle";
import { cyclePaneFocus } from "../lib/paneFocus";
import { AskAIOverlay } from "../components/meeting/AskAIOverlay";
import { CommandPalette } from "../components/shared/CommandPalette";
import { SystemAudioPermissionDialog } from "../components/shared/SystemAudioPermissionDialog";
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
  const sidebarUserToggled = useUIStore((s) => s.sidebarUserToggled);
  const askAIOpen = useUIStore((s) => s.askAIOpen);
  // Drag-over affordance for audio import (plan v9 #1 polish): without it
  // a dragged Voice Memo gives no hint the window is a drop target.
  const [audioDragOver, setAudioDragOver] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  // Route-change a11y (plan v6): move focus to the new view's heading so
  // VoiceOver announces where you landed, and keep the window title honest.
  useEffect(() => {
    const titles: Array<[RegExp, string]> = [
      [/^\/meetings/, "All meetings"],
      [/^\/meeting\//, "Meeting"],
      [/^\/tasks/, "Tasks"],
      [/^\/folders/, "Folders"],
      [/^\/calendar/, "Calendar"],
      [/^\/insights/, "Insights"],
      [/^\/settings/, "Settings"],
      [/^\/$/, "Home"],
    ];
    const section = titles.find(([re]) => re.test(currentPath))?.[1] ?? "Perchnote";
    document.title = section === "Perchnote" ? "Perchnote" : `${section} — Perchnote`;
    // Focus the first heading of the new view without scrolling jank.
    const h = document.querySelector<HTMLElement>("main h1, main h2, [data-view-heading]");
    if (h) {
      h.setAttribute("tabindex", "-1");
      h.focus({ preventScroll: true });
    }
  }, [currentPath]);
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
    void import("../lib/editorFontSize").then((m) => m.initEditorFontSize());
    initRecordingListeners();
  }, []);

  // NOTE: Auto-focus-mode-on-recording intentionally removed.
  // The MeetingListPanel stays visible during recording so MeetingBanner quick-stop works.
  // Users can still manually toggle focus mode via Cmd+\.

  // Create new meeting helper
  const router = useRouter();

  const createNewMeeting = useCallback(async (title?: string) => {
    try {
      const dateStr = new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
      }).format(new Date());
      const m = await ipc.createMeeting(title?.trim() || `Meeting — ${dateStr}`);
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      useUIStore.getState().setPendingAutoStart(m.id);
      navigate({ to: "/meeting/$id", params: { id: m.id } });
    } catch (err) {
      toast.error(toUserMessage(err), "Couldn't create the meeting");
    }
  }, [navigate, queryClient]);

  // Quick voice note (plan v11 #1): the flow lives in lib/quickNote so the
  // tray listener, the command palette, and ⌘⇧N all share one code path.
  const createQuickNote = useCallback(
    () =>
      createQuickVoiceNote(queryClient, (id) =>
        navigate({ to: "/meeting/$id", params: { id } }),
      ),
    [navigate, queryClient],
  );

  // perchnote:// deep links (plan v8 B5): one handler for both delivery
  // paths — the runtime `deep-action` event and the cold-start drain below.
  const dispatchDeep = useCallback(
    (a: DeepActionWire) =>
      dispatchDeepAction(a, {
        navigateToMeeting: (id) => navigate({ to: "/meeting/$id", params: { id } }),
        createNewMeeting,
      }),
    [createNewMeeting, navigate]
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && !e.shiftKey && e.key === "n") { e.preventDefault(); createNewMeeting(); }
      // ⌘⇧N — Quick Voice Note: record a thought instantly. Same flow the
      // tray item and the palette row use (discoverability batch).
      if (meta && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); createQuickNote(); }
      if (meta && e.key === "b") { e.preventDefault(); useUIStore.getState().toggleSidebar(); }
      if (meta && e.key === "j") { e.preventDefault(); useUIStore.getState().toggleAskAI(); }
      // ⌘E — the palette has advertised this shortcut; MeetingView's
      // listener triggers the enhance flow when a meeting is on screen.
      if (meta && !e.shiftKey && e.key === "e") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("palette-enhance-notes"));
      }
      if (meta && e.key === "t") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("open-transcript-drawer"));
      }
      if (meta && e.key === ",") { e.preventDefault(); navigate({ to: "/settings" }); }
      if (meta && e.key === "k") { e.preventDefault(); }
      if (meta && e.key === "f") {
        e.preventDefault();
        // ⌘F was a dead key wherever the panel was hidden (deep review P2):
        // the focus event's only listener lives INSIDE the panel. Force the
        // panel visible (marks user intent so the home-default doesn't
        // re-hide it), leave panel-less routes for a meetings surface, and
        // dispatch only after the panel has mounted.
        const path = window.location.pathname;
        if (path.startsWith("/folders") || path === "/settings") {
          navigate({ to: "/" });
        }
        useUIStore.getState().showSidebar();
        setTimeout(() => document.dispatchEvent(new CustomEvent("focus-meeting-search")), 120);
      }
      if (meta && e.shiftKey && e.key === "F") { e.preventDefault(); navigate({ to: "/" }); }
      if (meta && e.key === "\\") { e.preventDefault(); useUIStore.getState().toggleFocusMode(); }
      // History pathing — every deep link (task → meeting, search result,
      // calendar event) is otherwise a one-way trip.
      // ⌘1–5: jump straight to a rail section (standard macOS pattern)
      if (meta && !e.shiftKey && e.key === "1") { e.preventDefault(); navigate({ to: "/" }); }
      if (meta && !e.shiftKey && e.key === "2") { e.preventDefault(); navigate({ to: "/tasks" }); }
      if (meta && !e.shiftKey && e.key === "3") { e.preventDefault(); navigate({ to: "/folders" }); }
      if (meta && !e.shiftKey && e.key === "4") { e.preventDefault(); navigate({ to: "/calendar" }); }
      if (meta && !e.shiftKey && e.key === "5") { e.preventDefault(); navigate({ to: "/insights" }); }
      if (meta && e.key === "[") { e.preventDefault(); router.history.back(); }
      if (meta && e.key === "]") { e.preventDefault(); router.history.forward(); }
      if (meta && e.key === "/") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("open-shortcuts-help"));
      }
      if (meta && e.key === "Backspace") { e.preventDefault(); }
      // F6 cycles the major panes (list → notes → transcript), the
      // standard pane-cycling key. Works from inside the editor too.
      if (e.key === "F6") {
        e.preventDefault();
        cyclePaneFocus(e.shiftKey ? -1 : 1);
      }
      // Escape is owned by the overlay dismissal ladder (lib/overlayStack);
      // AskAI registers itself via its focus trap.
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createNewMeeting, createQuickNote, navigate, router]);

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
          queryClient.invalidateQueries({ queryKey: ["folderMembershipsMap"] });
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
      // Tray menu actions — these events previously fired into the void.
      listen("tray-new-meeting", () => createNewMeeting()),
      listen("tray-quick-note", () => createQuickNote()),
      listen<string>("tray-open-meeting", (e) => {
        navigate({ to: "/meeting/$id", params: { id: e.payload } });
      }),
      listen("tray-toggle-recording", async () => {
        const store = useRecordingStore.getState();
        if (store.isRecording) {
          const meetingId = await store.stopRecording();
          if (meetingId) {
            navigate({ to: "/meeting/$id", params: { id: meetingId } });
          }
        } else {
          createNewMeeting(); // creates a meeting and auto-starts recording
        }
      }),
      listen("user-context-generated", () => {
        queryClient.invalidateQueries({ queryKey: ["setting", "user_context"] });
        queryClient.invalidateQueries({ queryKey: ["setting", "user_context_auto"] });
        toast.info("Updated “About You” from your meetings — review it in Settings");
      }),
      // perchnote:// deep links (plan v8 B5) — Raycast/Shortcuts/etc. The
      // backend parses every verb into one wire-shaped payload.
      listen<DeepActionWire>("deep-action", (e) => {
        dispatchDeep(e.payload);
      }),
      // Accuracy pass swapped in the whole-file re-decode (plan v10 #3) —
      // refresh the transcript anywhere it's on screen so the drawer
      // doesn't show the superseded live chunks until reopened. Auto-
      // diarize (plan v10 #1) reuses this event after re-keying speakers,
      // so labels and the Speakers panel refresh too.
      listen<{ meeting_id: string }>("transcript-upgraded", (e) => {
        queryClient.invalidateQueries({ queryKey: ["transcript", e.payload.meeting_id] });
        // The receipts staleness badge keys its live sha separately (QA audit P3).
        queryClient.invalidateQueries({ queryKey: ["transcript-sha", e.payload.meeting_id] });
        queryClient.invalidateQueries({ queryKey: ["meeting", e.payload.meeting_id] });
        queryClient.invalidateQueries({ queryKey: ["speakerLabels", e.payload.meeting_id] });
        queryClient.invalidateQueries({ queryKey: ["unknown-speakers", e.payload.meeting_id] });
      }),
      // Speakers named themselves (plan v10 #1): the post-completion
      // diarize pass matched a diarized voice to an enrolled profile above
      // the strict threshold. One chip per speaker, each with its own Undo
      // that deletes exactly that label row.
      listen<{
        meeting_id: string;
        named: Array<{ speaker_key: string; display_name: string; label_id: string; similarity: number }>;
      }>("speakers-auto-named", (e) => {
        const meetingId = e.payload.meeting_id;
        const refresh = () => {
          queryClient.invalidateQueries({ queryKey: ["speakerLabels", meetingId] });
          queryClient.invalidateQueries({ queryKey: ["unknown-speakers", meetingId] });
          queryClient.invalidateQueries({ queryKey: ["transcript", meetingId] });
        };
        refresh();
        for (const n of e.payload.named) {
          toast.action(
            `Named ${n.display_name} automatically`,
            "Undo",
            async () => {
              try {
                await ipc.deleteSpeakerLabel(n.label_id);
              } catch {
                // Row already gone (renamed/merged meanwhile) — fine.
              }
              refresh();
            },
            "Recognized a voice",
          );
        }
      }),
      // Transcription drained → meeting flipped to "complete" in the
      // backend. Refresh anything keyed on status so the list badge,
      // Enhance pill, insights, and week review see it immediately.
      listen<{ meeting_id: string }>("meeting-completed", (e) => {
        queryClient.invalidateQueries({ queryKey: ["meetings"] });
        queryClient.invalidateQueries({ queryKey: ["meeting", e.payload.meeting_id] });
        queryClient.invalidateQueries({ queryKey: ["action-items"] });
        // Voice-note self-titling (plan v11 #1): a finished quick note keeps
        // its placeholder only until the transcript can do better. Best-
        // effort, first segment's opening words; the user can rename anytime.
        void (async () => {
          try {
            const meeting = await ipc.getMeeting(e.payload.meeting_id);
            if (!meeting?.title.startsWith("Voice note — ")) return;
            const t = await ipc.getTranscriptByMeeting(e.payload.meeting_id);
            if (!t) return;
            const segments: Array<{ text?: string }> = JSON.parse(t.segments);
            const first = segments.find((sg) => sg.text?.trim())?.text?.trim();
            if (!first) return;
            const words = first.split(/\s+/).slice(0, 8).join(" ");
            await ipc.updateMeetingTitle(e.payload.meeting_id, `Voice note: ${words}`);
            queryClient.invalidateQueries({ queryKey: ["meetings"] });
            queryClient.invalidateQueries({ queryKey: ["meeting", e.payload.meeting_id] });
          } catch {
            /* the placeholder title is fine */
          }
        })();
        // Per-series auto-run recipe (plan v10 #8): if this meeting's title
        // is bound to a recipe, run it now and park the output as a
        // dismissible card on the meeting — never written into notes,
        // never persisted. Strictly best-effort: any failure is silent
        // (the user never asked for anything in this moment).
        void (async () => {
          try {
            const { getSeriesRecipe } = await import("../lib/recipes");
            const meeting = await ipc.getMeeting(e.payload.meeting_id);
            if (!meeting) return;
            const recipe = await getSeriesRecipe(meeting.title);
            if (!recipe) return;
            // DECISION (review P3-5): auto-run always runs against the
            // meeting that just completed, even for recipes saved with a
            // cross-meeting scope — "run when meetings like this finish"
            // means THIS meeting is the subject. The scope applies to
            // manual runs from the panel.
            if (!(await ipc.checkAiConfigured())) return;
            const answer = await ipc.chatWithMeeting(e.payload.meeting_id, recipe.prompt);
            if (!answer.trim()) return;
            useUIStore.getState().setRecipeCard({
              meetingId: e.payload.meeting_id,
              recipeName: recipe.name,
              text: answer,
            });
            toast.action(
              `“${recipe.name}” ran on this meeting`,
              "Open",
              () => navigate({ to: "/meeting/$id", params: { id: e.payload.meeting_id } }),
              "Recipe ready",
            );
          } catch {
            /* auto-runs are opportunistic; a failed one stays invisible */
          }
        })();
      }),
      // Self-titling for placeholder meetings: the backend swapped
      // "Untitled Meeting" / "Meeting — <timestamp>" for a short transcript
      // descriptor. Refresh, re-mirror under the new name, offer Undo.
      listen<{ meeting_id: string; title: string; previous_title: string }>(
        "meeting-retitled",
        (e) => {
          const { meeting_id: meetingId, title, previous_title: previousTitle } = e.payload;
          queryClient.invalidateQueries({ queryKey: ["meetings"] });
          queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
          scheduleMirror(meetingId);
          toast.action(
            `Named “${title}” from the transcript`,
            "Undo",
            async () => {
              try {
                const m = await ipc.getMeeting(meetingId);
                if (m?.title !== title) return; // renamed since — leave it
                await ipc.updateMeetingTitle(meetingId, previousTitle);
                queryClient.invalidateQueries({ queryKey: ["meetings"] });
                queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
                scheduleMirror(meetingId);
              } catch {
                /* the new title stands; renaming by hand still works */
              }
            },
            "Meeting named",
          );
        },
      ),
      // Instant recap (plan v3 rank 2): the backend says this completed
      // meeting is eligible — run the shared enhance flow so the notes are
      // waiting without a click, then tell the user.
      listen<{ meeting_id: string }>("auto-enhance", async (e) => {
        const meetingId = e.payload.meeting_id;
        // Publish the in-flight id so the post-recording screen shows
        // "Generating your notes…" instead of a redundant manual Enhance
        // button (this run never touches the meeting's enhance machine).
        useUIStore.getState().setAutoEnhancingMeetingId(meetingId);
        try {
          const { generated } = await runEnhance(queryClient, meetingId);
          const n = generated.action_items.length;
          const body = n > 0 ? `${n} action item${n === 1 ? "" : "s"} captured` : "Summary ready";
          ipc.notifyUser("Notes ready", body).catch(() => {});
          toast.action(body, "Open", () =>
            navigate({ to: "/meeting/$id", params: { id: meetingId } }),
            "Notes ready",
          );
        } catch (err) {
          // Quietly log — the user never asked for this run; the manual
          // Enhance button remains and reports its own errors. Clearing the
          // flag below drops the post-recording screen back to offering a
          // manual Generate (the only failure signal the screen gets).
          console.error("instant recap failed:", err);
        } finally {
          useUIStore.getState().setAutoEnhancingMeetingId(null);
        }
      }),
      // Empty recording discarded: a stop that captured no audio (and no
      // transcript or notes) deletes its own meeting row backend-side rather
      // than leaving a turd. Drop it from the list; MeetingView navigates
      // away if it's the one on screen.
      listen<{ meeting_id: string }>("meeting-discarded", () => {
        queryClient.invalidateQueries({ queryKey: ["meetings"] });
        queryClient.invalidateQueries({ queryKey: ["action-items"] });
      }),
      // Audio-file import (plan v9 #1): drop a Voice Memo / call recording
      // anywhere on the window and it becomes a normal meeting. Files run
      // sequentially — whisper holds one Metal state.
      listen<{ paths?: string[] }>("tauri://drag-enter", (e) => {
        const hasAudio = (e.payload.paths ?? []).some((p) =>
          /\.(wav|mp3|m4a|aac|aiff|aif|caf|flac)$/i.test(p),
        );
        if (hasAudio) setAudioDragOver(true);
      }),
      listen("tauri://drag-leave", () => setAudioDragOver(false)),
      listen<{ paths?: string[] }>("tauri://drag-drop", async (e) => {
        setAudioDragOver(false);
        const audio = (e.payload.paths ?? []).filter((p) =>
          /\.(wav|mp3|m4a|aac|aiff|aif|caf|flac)$/i.test(p),
        );
        if (audio.length === 0) return;
        for (const p of audio) {
          const name = p.split("/").pop() ?? p;
          toast.info(`Importing “${name}” — transcribing in the background`);
          try {
            const id = await ipc.importAudioFile(p);
            queryClient.invalidateQueries({ queryKey: ["meetings"] });
            toast.action(
              "Transcribed and ready",
              "Open",
              () => navigate({ to: "/meeting/$id", params: { id } }),
              `Imported “${name}”`,
            );
          } catch (err) {
            toast.error(toUserMessage(err), `Couldn't import “${name}”`);
          }
        }
      }),
      // Call detection: a meeting app started using the mic and we're not
      // recording. One click lands in the right meeting, already recording.
      listen<{ app_name: string; meeting_id: string | null; meeting_title: string | null }>(
        "call-detected",
        (e) => {
          const { app_name, meeting_id, meeting_title } = e.payload;
          if (useRecordingStore.getState().isRecording) return;
          toast.action(
            meeting_title ? `Looks like “${meeting_title}”.` : "Want to record it?",
            "Record",
            () => {
              if (meeting_id) {
                useUIStore.getState().setPendingAutoStart(meeting_id);
                navigate({ to: "/meeting/$id", params: { id: meeting_id } });
              } else {
                createNewMeeting(); // creates a meeting and auto-starts recording
              }
            },
            `In a call on ${app_name}?`
          );
        }
      ),
    ];
    // Cold-start deep links: a perchnote:// URL that LAUNCHED the app was
    // emitted before these listeners existed. Drain it now (one-shot on the
    // backend, so StrictMode/remounts can't double-fire) through the same
    // dispatcher the runtime listener uses. record-stop at launch is a
    // natural no-op — nothing can be recording yet.
    ipc.takeLaunchDeepActions().then(async (actions) => {
      for (const a of actions) await dispatchDeep(a);
    }).catch(() => { /* never block startup on automation */ });
    return () => { subs.forEach((p) => p.then((fn) => fn())); };
  }, [createNewMeeting, createQuickNote, dispatchDeep, navigate]);

  if (isLoading && !isOnboardingPreviewRoute) return null;
  if (!isComplete && !isOnboardingPreviewRoute) {
    return <OnboardingFlow onComplete={handleCompleteOnboarding} />;
  }
  if (isOnboardingPreviewRoute) return <Outlet />;

  // Shared with IconRail so the rail's ⌘B toggle reports the same state
  // (aria-expanded) the layout actually renders.
  const hideMeetingList = isMeetingListHidden(currentPath, {
    focusMode,
    sidebarCollapsed,
    sidebarUserToggled,
  });

  return (
    <div className="h-screen flex overflow-hidden app-shell-glow" style={{ background: "var(--color-bg-primary)", color: "var(--color-text-primary)" }}>
      {/* Icon rail — always visible */}
      <IconRail />
      <KeyboardShortcutsHelp />

      {/* Meeting list panel — conditionally visible */}
      {!hideMeetingList && (
        <div className="hidden md:contents">
          <MeetingListPanel />
        </div>
      )}

      {/* Main content */}
      <main data-pane="main" className="flex-1 overflow-auto">
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

      {/* Blocks recording start when system audio is on but Screen Recording
          permission is missing. Driven by the recording store, so it works no
          matter which screen kicked off the recording. */}
      <SystemAudioPermissionDialog />

      {/* Drop-target affordance while an audio file is dragged over the
          window (plan v9 #1) — purely visual, never intercepts the drop. */}
      {audioDragOver && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg-primary/60"
        >
          <div className="rounded-2xl border-2 border-dashed border-accent/60 bg-bg-secondary px-8 py-6 shadow-2xl">
            <p className="text-sm font-medium text-text-primary">
              Drop to import as a meeting
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Converted, transcribed, and searchable — all on this Mac.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
