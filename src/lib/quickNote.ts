import type { QueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc";
import { useUIStore } from "../stores/uiStore";
import { toast } from "../stores/toastStore";
import { toUserMessage } from "./errors";

/**
 * Quick voice note (plan v11 #1): a meeting like any other — tagged so
 * search/filters can target voice notes — that starts recording the
 * moment it opens. The tag is garnish: a tagging hiccup never costs
 * the capture.
 *
 * Shared by the tray menu, the command palette, and ⌘⇧N (discoverability
 * batch: the tray used to be the ONLY entry point, so the feature was
 * invisible from inside the app).
 */
export async function createQuickVoiceNote(
  queryClient: QueryClient,
  navigateToMeeting: (id: string) => void,
): Promise<void> {
  try {
    const dateStr = new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date());
    const m = await ipc.createMeeting(`Voice note ${dateStr}`);
    try {
      const tags = await ipc.listTags();
      const tag =
        tags.find((t) => t.name === "voice-note") ?? (await ipc.createTag("voice-note"));
      await ipc.addTagToMeeting(m.id, tag.id);
    } catch {
      /* tag is garnish */
    }
    queryClient.invalidateQueries({ queryKey: ["meetings"] });
    useUIStore.getState().setPendingAutoStart(m.id);
    navigateToMeeting(m.id);
  } catch (err) {
    toast.error(toUserMessage(err), "Couldn't start the voice note");
  }
}
