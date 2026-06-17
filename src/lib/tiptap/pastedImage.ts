import { Node, mergeAttributes } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc } from "../ipc";
import type { Attachment } from "../ipc";

/**
 * A screenshot pasted into the notes during a call (plan v9 #13).
 *
 * Dependency-free custom node (timestampChip/actionItem pattern — no
 * @tiptap/extension-image). The attr stores the ABSOLUTE disk path of the
 * saved attachment: the doc JSON survives reloads, and the serializer can
 * emit a tool-agnostic markdown link (B7 precedent — raw absolute paths).
 * The DOM <img> src goes through Tauri's asset protocol (same trick as the
 * audio player), so the bytes never leave disk.
 */
export const PastedImage = Node.create({
  name: "pastedImage",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      /** Absolute path of the saved attachment on disk. */
      src: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-path") ?? "",
        renderHTML: (attrs) => {
          const path = typeof attrs.src === "string" ? attrs.src : "";
          return {
            // Raw path for round-tripping; asset URL for the webview.
            "data-path": path,
            src: path ? convertFileSrc(path) : "",
          };
        },
      },
      alt: { default: "pasted image" },
    };
  },

  parseHTML() {
    return [{ tag: "img[data-pasted-image]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { "data-pasted-image": "" })];
  },
});

/** Mirrors MAX_PASTED_IMAGE_BYTES in settings.rs — reject before shipping
 *  ~27 MB of base64 over IPC just to be told no. */
export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

/** The PNG on the clipboard, if any. macOS screenshots paste as image/png;
 *  other flavors fall through untouched. */
export function extractPngFile(
  data: Pick<DataTransfer, "items" | "files"> | null,
): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type === "image/png") {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of Array.from(data.files ?? [])) {
    if (file.type === "image/png") return file;
  }
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface PasteImageDeps {
  /** Injectable for tests; defaults to the real IPC call. */
  saveImage?: (meetingId: string, base64Png: string) => Promise<Attachment>;
  /** Human-readable failure sink (NoteEditor shows a toast). */
  onError?: (message: string) => void;
}

/**
 * editorProps.handlePaste for NoteEditor (plan v9 #13): a PNG on the
 * clipboard is saved through save_pasted_image and inserted as a
 * pastedImage node at the cursor. Returns false for everything else, so
 * non-image pastes hit TipTap's default path COMPLETELY unaffected.
 *
 * Synchronous true/false decides who owns the event; the save + insert
 * completes asynchronously afterwards.
 */
export function handleImagePaste(
  view: EditorView,
  event: ClipboardEvent,
  meetingId: string | undefined,
  deps: PasteImageDeps = {},
): boolean {
  if (!meetingId) return false;
  const file = extractPngFile(event.clipboardData);
  if (!file) return false;

  event.preventDefault();
  if (file.size > MAX_PASTED_IMAGE_BYTES) {
    deps.onError?.("Images larger than 20 MB can't be pasted");
    return true;
  }

  void (async () => {
    try {
      const base64 = await fileToBase64(file);
      const save = deps.saveImage ?? ipc.savePastedImage;
      const attachment = await save(meetingId, base64);
      if (view.isDestroyed) return; // navigated away mid-save
      // Read state fresh — the user may have kept typing during the save.
      const { state } = view;
      const nodeType = state.schema.nodes[PastedImage.name];
      if (!nodeType) return;
      const node = nodeType.create({ src: attachment.file_path });
      view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    } catch (e) {
      window.console.error("paste image failed:", e);
      deps.onError?.("Couldn't save the pasted image");
    }
  })();
  return true;
}
