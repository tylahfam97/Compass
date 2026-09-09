import { create } from "zustand";
import type { ReactNode } from "react";

export type ToastTone = "info" | "success" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  tone?: ToastTone;
  action?: ToastAction;
  /** Auto-dismiss delay in ms. 0 keeps the toast until it's dismissed by hand. */
  duration?: number;
}

export interface Toast {
  id: number;
  message: ReactNode;
  tone: ToastTone;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  show: (message: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

/** Errors stay put - they usually carry a Retry action and vanishing before the user has read
 *  them is exactly the silent-failure problem this store exists to fix. */
const DEFAULT_DURATION: Record<ToastTone, number> = {
  info: 5000,
  success: 5000,
  error: 0,
};

/** Oldest toasts are dropped past this so a failing loop can't bury the screen. */
const MAX_VISIBLE = 3;

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  show: (message, options = {}) => {
    const id = nextId++;
    const tone = options.tone ?? "info";
    set((s) => ({
      toasts: [...s.toasts, { id, message, tone, action: options.action }].slice(-MAX_VISIBLE),
    }));

    const duration = options.duration ?? DEFAULT_DURATION[tone];
    if (duration > 0) setTimeout(() => get().dismiss(id), duration);
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Callable from anywhere, including plain `.catch()` blocks outside a component. */
export const toast = {
  info: (message: ReactNode, options?: Omit<ToastOptions, "tone">) =>
    useToastStore.getState().show(message, { ...options, tone: "info" }),
  success: (message: ReactNode, options?: Omit<ToastOptions, "tone">) =>
    useToastStore.getState().show(message, { ...options, tone: "success" }),
  error: (message: ReactNode, options?: Omit<ToastOptions, "tone">) =>
    useToastStore.getState().show(message, { ...options, tone: "error" }),
};

/** Drop-in replacement for `.catch(console.error)` on a page's data load. A load that fails
 *  silently leaves the user staring at an empty page with no idea anything went wrong, which
 *  in a finance app reads as lost data. Pass `retry` to offer a one-click reload. */
export function reportLoadError(what: string, retry?: () => void) {
  return (err: unknown) => {
    console.error(err);
    toast.error(
      `Couldn't load ${what}.`,
      retry ? { action: { label: "Retry", onClick: retry } } : undefined
    );
  };
}

/** `.catch()` handler for a page loader that shows a skeleton. Clears the loading flag first -
 *  page loaders set it at the top and clear it at the bottom, so a throw in between would
 *  otherwise leave the skeleton spinning forever behind the error toast. */
export function handleLoadFailure(
  what: string,
  setLoading: (loading: boolean) => void,
  retry?: () => void
) {
  return (err: unknown) => {
    setLoading(false);
    reportLoadError(what, retry)(err);
  };
}
