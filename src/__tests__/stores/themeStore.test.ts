import { describe, it, expect, beforeEach, vi } from "vitest";
import { lightenHex, hexToRgba } from "../../stores/themeStore";

describe("themeStore helpers", () => {
  beforeEach(() => {
    // No setup needed — testing pure functions
  });

  describe("lightenHex", () => {
    it("lightens a hex color by the given amount", () => {
      // #000000 + 15 = #0f0f0f
      expect(lightenHex("#000000", 15)).toBe("#0f0f0f");
    });

    it("clamps at 255 and does not overflow", () => {
      expect(lightenHex("#ffffff", 50)).toBe("#ffffff");
    });

    it("handles a midrange color correctly", () => {
      // r=100(0x64), g=150(0x96), b=200(0xc8), +10 = r=110(0x6e), g=160(0xa0), b=210(0xd2)
      expect(lightenHex("#6496c8", 10)).toBe("#6ea0d2");
    });
  });

  describe("hexToRgba", () => {
    it("converts black to rgba(0,0,0,alpha)", () => {
      expect(hexToRgba("#000000", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
    });

    it("converts white to rgba(255,255,255,alpha)", () => {
      expect(hexToRgba("#ffffff", 1)).toBe("rgba(255, 255, 255, 1)");
    });

    it("converts a custom color correctly", () => {
      // #5a9c6a = r=90, g=156, b=106
      expect(hexToRgba("#5a9c6a", 0.1)).toBe("rgba(90, 156, 106, 0.1)");
    });

    it("uses 0 alpha to produce transparent", () => {
      expect(hexToRgba("#ff0000", 0)).toBe("rgba(255, 0, 0, 0)");
    });
  });
});

describe("themeStore actions", () => {
  beforeEach(() => {
    // Stub localStorage so store action calls don't throw
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
  });

  it("setTheme persists to localStorage and updates state", async () => {
    const { useThemeStore } = await import("../../stores/themeStore");
    const { setItem } = window.localStorage as unknown as { setItem: ReturnType<typeof vi.fn> };
    useThemeStore.getState().setTheme("light");
    expect(setItem).toHaveBeenCalledWith("theme", "light");
    expect(useThemeStore.getState().theme).toBe("light");
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });

  it("setAccentColor persists to localStorage and updates state", async () => {
    const { useThemeStore } = await import("../../stores/themeStore");
    const { setItem } = window.localStorage as unknown as { setItem: ReturnType<typeof vi.fn> };
    useThemeStore.getState().setAccentColor("#ff0000");
    expect(setItem).toHaveBeenCalledWith("accentColor", "#ff0000");
    expect(useThemeStore.getState().accentColor).toBe("#ff0000");
  });
});
