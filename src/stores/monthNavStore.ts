import { create } from "zustand";

interface MonthNavState {
  /** Selected "YYYY-MM" per page (keyed by an arbitrary page id, e.g. "dashboard") - a plain
   *  in-memory store (not persisted to disk) so a page's selected month survives navigating to
   *  another tab and back (React Router unmounts the page component on route change, which would
   *  otherwise reset a plain useState back to its initial value), while still resetting to the
   *  real current month on a fresh app launch. */
  months: Record<string, string>;
  setMonth: (key: string, month: string) => void;
}

export const useMonthNavStore = create<MonthNavState>((set) => ({
  months: {},
  setMonth: (key, month) => set((s) => ({ months: { ...s.months, [key]: month } })),
}));
