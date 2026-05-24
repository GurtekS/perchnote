import { create } from "zustand";

type Theme = "dark" | "light" | "system";

interface ThemeStore {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  accentColor: string;
  setTheme: (theme: Theme) => void;
  setAccentColor: (color: string) => void;
  clearCustomAccent: () => void;
}

function hexToHsl(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue = 0;
  switch (max) {
    case r: hue = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: hue = ((b - r) / d + 2) / 6; break;
    case b: hue = ((r - g) / d + 4) / 6; break;
  }
  return [Math.round(hue * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100, ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return ln - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Generate 8 folder color swatches derived from the accent hue. */
export function generateFolderPalette(accentHex: string): string[] {
  const [h, s, l] = hexToHsl(accentHex);
  const sat = Math.max(50, Math.min(70, s));
  const lit = Math.max(40, Math.min(55, l));
  return [0, 30, 60, 120, 180, 210, 270, 300].map(offset =>
    hslToHex((h + offset) % 360, sat, lit)
  );
}

/** Pick a folder display color — same hue as accent, slight lightness variation per folder. */
export function folderColorFromId(id: string, accentHex: string): string {
  const [h, s] = hexToHsl(accentHex);
  const sat = Math.max(55, Math.min(75, s));
  const options = [42, 47, 52, 57, 62];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return hslToHex(h, sat, options[Math.abs(hash) % options.length]);
}

export function lightenHex(hex: string, amount: number): string {
  const h = hex.replace("#", "");
  const r = Math.min(255, parseInt(h.slice(0, 2), 16) + amount);
  const g = Math.min(255, parseInt(h.slice(2, 4), 16) + amount);
  const b = Math.min(255, parseInt(h.slice(4, 6), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getSystemTheme(): "dark" | "light" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

function resolveTheme(theme: Theme): "dark" | "light" {
  return theme === "system" ? getSystemTheme() : theme;
}

/** Default accent per resolved theme — must match globals.css */
const THEME_ACCENT_DEFAULTS: Record<"dark" | "light", string> = {
  dark: "#6366f1",
  light: "#4a8c5a",
};

function applyTheme(resolved: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", resolved);
  // Clear any previously applied inline accent overrides so the CSS cascade
  // ([data-theme] rules in globals.css) can provide the correct theme default.
  // If a custom accent is set it will be re-applied immediately after.
  const root = document.documentElement;
  root.style.removeProperty("--color-accent");
  root.style.removeProperty("--color-accent-hover");
  root.style.removeProperty("--color-accent-soft");
  root.style.removeProperty("--accent-rgb");
  root.style.removeProperty("--accent");
}

function applyAccentColor(hex: string) {
  const root = document.documentElement;
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  root.style.setProperty("--color-accent", hex);
  root.style.setProperty("--color-accent-hover", lightenHex(hex, 16));
  root.style.setProperty("--color-accent-soft", hexToRgba(hex, 0.1));
  root.style.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty("--accent", hex);
}

// Load persisted theme
const stored = localStorage.getItem("theme") as Theme | null;
const initial = stored || "dark";
const initialResolved = resolveTheme(initial);
applyTheme(initialResolved);

const storedAccent = localStorage.getItem("accentColor"); // null = user never picked one
const initialAccent = storedAccent || THEME_ACCENT_DEFAULTS[initialResolved];
// Only override via inline styles if the user explicitly chose an accent.
// Otherwise let the [data-theme] CSS rules provide the right default per theme.
if (storedAccent) {
  applyAccentColor(storedAccent);
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: initial,
  resolvedTheme: initialResolved,
  accentColor: initialAccent,
  setTheme: (theme) => {
    const resolved = resolveTheme(theme);
    localStorage.setItem("theme", theme);
    applyTheme(resolved);
    const customAccent = localStorage.getItem("accentColor");
    if (customAccent) {
      applyAccentColor(customAccent);
    }
    const effectiveAccent = customAccent || THEME_ACCENT_DEFAULTS[resolved];
    set({ theme, resolvedTheme: resolved, accentColor: effectiveAccent });
  },
  setAccentColor: (color) => {
    localStorage.setItem("accentColor", color);
    applyAccentColor(color);
    set({ accentColor: color });
  },
  clearCustomAccent: () => {
    localStorage.removeItem("accentColor");
    const resolved = useThemeStore.getState().resolvedTheme;
    // Remove inline overrides so CSS cascade applies theme default
    const root = document.documentElement;
    root.style.removeProperty("--color-accent");
    root.style.removeProperty("--color-accent-hover");
    root.style.removeProperty("--color-accent-soft");
    root.style.removeProperty("--accent-rgb");
    root.style.removeProperty("--accent");
    set({ accentColor: THEME_ACCENT_DEFAULTS[resolved] });
  },
}));

// Listen for system theme changes
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const state = useThemeStore.getState();
    if (state.theme === "system") {
      const resolved = getSystemTheme();
      applyTheme(resolved);
      const customAccent = localStorage.getItem("accentColor");
      if (customAccent) applyAccentColor(customAccent);
      const effectiveAccent = customAccent || THEME_ACCENT_DEFAULTS[resolved];
      useThemeStore.setState({ resolvedTheme: resolved, accentColor: effectiveAccent });
    }
  });
}
