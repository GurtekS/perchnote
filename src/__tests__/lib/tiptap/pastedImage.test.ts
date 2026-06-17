// Editor-level clipboard simulation is impractical in jsdom (ProseMirror
// needs real contenteditable + ClipboardEvent plumbing), so these tests
// drive the extracted handler — handleImagePaste — directly against a real
// headless TipTap editor, the same approach as actionItem.test.ts.
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  PastedImage,
  extractPngFile,
  handleImagePaste,
  MAX_PASTED_IMAGE_BYTES,
} from "../../../lib/tiptap/pastedImage";
import type { Attachment } from "../../../lib/ipc";

vi.mock("../../../lib/ipc", () => ({
  ipc: { savePastedImage: vi.fn() },
}));

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MAGIC_B64 = "iVBORw0KGgo=";

function makeEditor() {
  return new Editor({ extensions: [StarterKit, PastedImage] });
}

function pngFile(bytes: Uint8Array = PNG_MAGIC): File {
  return new File([bytes as BlobPart], "screenshot.png", { type: "image/png" });
}

/** A minimal stand-in for the parts of ClipboardEvent the handler reads. */
function pasteEvent(items: Array<{ kind: string; type: string; file?: File }>) {
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      items: items.map((i) => ({
        kind: i.kind,
        type: i.type,
        getAsFile: () => i.file ?? null,
      })),
      files: [],
    },
  } as unknown as ClipboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function attachment(file_path: string): Attachment {
  return {
    id: "a1",
    meeting_id: "00000000-0000-4000-8000-000000000001",
    file_name: "pasted-1.png",
    file_path,
    file_type: "image/png",
    file_size: 8,
    created_at: "2026-06-10T00:00:00Z",
  };
}

describe("PastedImage node", () => {
  it("round-trips the absolute path through doc JSON (survives reload)", () => {
    const editor = new Editor({
      extensions: [StarterKit, PastedImage],
      content: {
        type: "doc",
        content: [{ type: "pastedImage", attrs: { src: "/data/attachments/m1/pasted-1.png" } }],
      },
    });
    expect(editor.getJSON().content?.[0]).toEqual({
      type: "pastedImage",
      attrs: { src: "/data/attachments/m1/pasted-1.png", alt: "pasted image" },
    });
    editor.destroy();
  });

  it("renders an <img> with the raw path in data-path (asset URL in src)", () => {
    const editor = new Editor({
      extensions: [StarterKit, PastedImage],
      content: {
        type: "doc",
        content: [{ type: "pastedImage", attrs: { src: "/data/attachments/m1/pasted-1.png" } }],
      },
    });
    const img = editor.view.dom.querySelector("img[data-pasted-image]");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("data-path")).toBe("/data/attachments/m1/pasted-1.png");
    // The mocked convertFileSrc is identity; in the app this is asset://…
    expect(img?.getAttribute("src")).toBe("/data/attachments/m1/pasted-1.png");
    editor.destroy();
  });
});

describe("extractPngFile", () => {
  it("finds the PNG among clipboard items", () => {
    const file = pngFile();
    const event = pasteEvent([
      { kind: "string", type: "text/plain" },
      { kind: "file", type: "image/png", file },
    ]);
    expect(extractPngFile(event.clipboardData)).toBe(file);
  });

  it("returns null for text-only and non-PNG clipboards", () => {
    expect(extractPngFile(pasteEvent([{ kind: "string", type: "text/plain" }]).clipboardData)).toBeNull();
    expect(
      extractPngFile(pasteEvent([{ kind: "file", type: "image/jpeg", file: pngFile() }]).clipboardData),
    ).toBeNull();
    expect(extractPngFile(null)).toBeNull();
  });
});

describe("handleImagePaste", () => {
  const MEETING = "00000000-0000-4000-8000-000000000001";

  it("leaves non-image pastes completely alone (returns false, no preventDefault)", async () => {
    const { ipc } = await import("../../../lib/ipc");
    const editor = makeEditor();
    const event = pasteEvent([{ kind: "string", type: "text/plain" }]);

    expect(handleImagePaste(editor.view, event, MEETING)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ipc.savePastedImage).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("does nothing without a meetingId (editor outside a meeting)", () => {
    const editor = makeEditor();
    const event = pasteEvent([{ kind: "file", type: "image/png", file: pngFile() }]);
    expect(handleImagePaste(editor.view, event, undefined)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("saves the PNG through ipc and inserts the node with the returned path", async () => {
    const { ipc } = await import("../../../lib/ipc");
    const saved = attachment("/data/attachments/m1/pasted-1.png");
    vi.mocked(ipc.savePastedImage).mockResolvedValueOnce(saved);
    const editor = makeEditor();
    const event = pasteEvent([{ kind: "file", type: "image/png", file: pngFile() }]);

    expect(handleImagePaste(editor.view, event, MEETING)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(ipc.savePastedImage).toHaveBeenCalledWith(MEETING, PNG_MAGIC_B64);
    });
    await vi.waitFor(() => {
      const nodes = editor.getJSON().content ?? [];
      const img = nodes.find((n) => n.type === "pastedImage");
      expect(img?.attrs?.src).toBe("/data/attachments/m1/pasted-1.png");
    });
    editor.destroy();
  });

  it("rejects oversize images locally — error message, no IPC, paste consumed", async () => {
    const { ipc } = await import("../../../lib/ipc");
    vi.mocked(ipc.savePastedImage).mockClear();
    const file = pngFile();
    Object.defineProperty(file, "size", { value: MAX_PASTED_IMAGE_BYTES + 1 });
    const onError = vi.fn();
    const editor = makeEditor();
    const event = pasteEvent([{ kind: "file", type: "image/png", file }]);

    expect(handleImagePaste(editor.view, event, MEETING, { onError })).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Images larger than 20 MB can't be pasted");
    expect(ipc.savePastedImage).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("surfaces a save failure via onError and inserts nothing", async () => {
    const onError = vi.fn();
    const saveImage = vi.fn().mockRejectedValue(new Error("disk full"));
    const editor = makeEditor();
    const event = pasteEvent([{ kind: "file", type: "image/png", file: pngFile() }]);

    expect(handleImagePaste(editor.view, event, MEETING, { saveImage, onError })).toBe(true);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith("Couldn't save the pasted image");
    });
    const types = (editor.getJSON().content ?? []).map((n) => n.type);
    expect(types).not.toContain("pastedImage");
    editor.destroy();
  });
});
