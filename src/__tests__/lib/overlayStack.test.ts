import { describe, expect, it, vi } from "vitest";
import { pushOverlay } from "../../lib/overlayStack";

const pressEscape = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

describe("overlayStack dismissal ladder", () => {
  it("Escape closes only the topmost overlay", () => {
    const drawer = vi.fn();
    const palette = vi.fn();
    const releaseDrawer = pushOverlay(drawer);
    const releasePalette = pushOverlay(palette);

    pressEscape();
    expect(palette).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();

    releasePalette();
    pressEscape();
    expect(drawer).toHaveBeenCalledTimes(1);
    releaseDrawer();
  });

  it("suppresses background Escape listeners while an overlay is open", () => {
    const background = vi.fn();
    window.addEventListener("keydown", background);

    const close = vi.fn();
    const release = pushOverlay(close);
    pressEscape();
    expect(close).toHaveBeenCalledTimes(1);
    expect(background).not.toHaveBeenCalled();

    release();
    pressEscape();
    expect(background).toHaveBeenCalledTimes(1); // stack empty → normal flow
    expect(close).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", background);
  });

  it("non-Escape keys pass through untouched", () => {
    const background = vi.fn();
    window.addEventListener("keydown", background);
    const release = pushOverlay(vi.fn());
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(background).toHaveBeenCalledTimes(1);
    release();
    window.removeEventListener("keydown", background);
  });

  it("releasing out of order keeps the ladder consistent", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const releaseA = pushOverlay(a);
    const releaseB = pushOverlay(b);
    const releaseC = pushOverlay(c);

    releaseB(); // middle layer unmounts (e.g. its meeting navigated away)
    pressEscape();
    expect(c).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    releaseC();
    pressEscape();
    expect(a).toHaveBeenCalledTimes(1);
    releaseA();
  });
});
