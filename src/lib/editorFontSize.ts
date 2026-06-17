import { ipc } from "./ipc";

/**
 * Editor font size (user request): one setting, applied as a CSS variable
 * on <html> so every TipTap surface follows instantly — the typing editor
 * uses it directly, AI notes render 2px tighter off the same variable.
 */
export const EDITOR_FONT_SIZES = [
  { value: "14px", label: "Small" },
  { value: "16px", label: "Default" },
  { value: "18px", label: "Large" },
] as const;

export const EDITOR_FONT_SIZE_KEY = "editor_font_size";

export function applyEditorFontSize(px: string | null | undefined): void {
  const known = EDITOR_FONT_SIZES.some((s) => s.value === px);
  if (px && known) {
    document.documentElement.style.setProperty("--editor-font-size", px);
  } else {
    document.documentElement.style.removeProperty("--editor-font-size");
  }
}

/** Read the stored size and apply it — called once at startup. */
export async function initEditorFontSize(): Promise<void> {
  try {
    applyEditorFontSize(await ipc.getSetting(EDITOR_FONT_SIZE_KEY));
  } catch {
    /* default stands */
  }
}
