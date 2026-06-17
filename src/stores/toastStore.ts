import { create } from "zustand";
import { announce } from "../lib/announce";

export interface Toast {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title?: string;
  message: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastStore {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${++nextId}`;
    const duration = toast.duration ?? 4000;
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    // Screen-reader announcement rides the pre-mounted live region, not the
    // toast DOM. Only problems interrupt; the rest waits politely.
    announce(
      toast.title ? `${toast.title}. ${toast.message}` : toast.message,
      toast.type === "error" || toast.type === "warning" ? "assertive" : "polite",
    );
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Convenience helpers
export const toast = {
  success: (message: string, title?: string) =>
    useToastStore.getState().addToast({ type: "success", message, title }),
  error: (message: string, title?: string) =>
    useToastStore.getState().addToast({ type: "error", message, title, duration: 6000 }),
  info: (message: string, title?: string) =>
    useToastStore.getState().addToast({ type: "info", message, title }),
  warning: (message: string, title?: string) =>
    useToastStore.getState().addToast({ type: "warning", message, title }),
  action: (message: string, actionLabel: string, onClick: () => void, title?: string) =>
    useToastStore.getState().addToast({ type: "info", message, title, duration: 8000, action: { label: actionLabel, onClick } }),
};
