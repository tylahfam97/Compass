import { create } from "zustand";
import { ONBOARDING_STEPS } from "@/lib/onboardingSteps";

const VISITED_KEY = "compass_onboarding_visited_steps";
const DISMISSED_KEY = "compass_onboarding_dismissed_forever";

function loadVisited(): Set<string> {
  try {
    const raw = localStorage.getItem(VISITED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveVisited(visited: Set<string>) {
  localStorage.setItem(VISITED_KEY, JSON.stringify([...visited]));
}

interface OnboardingStore {
  /** Step ids the user has opened/acknowledged at least once. */
  visitedSteps: Set<string>;
  /** True once "Don't show again" has been checked - suppresses the widget forever. */
  dismissedForever: boolean;
  /** Which step's spotlight/modal is currently open, if any. */
  activeStepId: string | null;
  /** Whether the checklist widget is expanded (vs. collapsed to a small pill). */
  checklistOpen: boolean;

  isComplete: () => boolean;
  markVisited: (id: string) => void;
  dismissForever: () => void;
  startStep: (id: string) => void;
  closeSpotlight: () => void;
  setChecklistOpen: (open: boolean) => void;
  /** Clears all progress and reopens the widget from scratch - used by "Replay tour". */
  restart: () => void;
}

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  visitedSteps: loadVisited(),
  dismissedForever: localStorage.getItem(DISMISSED_KEY) === "1",
  activeStepId: null,
  checklistOpen: false,

  isComplete: () => get().visitedSteps.size >= ONBOARDING_STEPS.length,

  markVisited: (id) => set((s) => {
    const next = new Set(s.visitedSteps);
    next.add(id);
    saveVisited(next);
    return { visitedSteps: next };
  }),

  dismissForever: () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    set({ dismissedForever: true, activeStepId: null });
  },

  startStep: (id) => set({ activeStepId: id, checklistOpen: true }),

  closeSpotlight: () => set({ activeStepId: null }),

  setChecklistOpen: (open) => set({ checklistOpen: open }),

  restart: () => {
    localStorage.removeItem(VISITED_KEY);
    localStorage.removeItem(DISMISSED_KEY);
    set({ visitedSteps: new Set(), dismissedForever: false, activeStepId: null, checklistOpen: true });
  },
}));
