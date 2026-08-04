import { create } from "zustand";

const LS_LAST_SEEN_MONTH_KEY = "compass_last_seen_month";

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

interface MonthRolloverState {
  /** True for the rest of this app session once we've detected the real-world month changed
   *  since the last time Compass was open - read by useAutoMonth so pages default to the new
   *  current month instead of silently falling back to the last month that has data. */
  justRolledOver: boolean;
  previousMonth: string | null;
  newMonth: string;
  /** Whether the celebratory modal has been shown/dismissed yet this session. */
  modalShown: boolean;
  dismissModal: () => void;
}

// Computed once at module load (before any component mounts/effects run), by comparing the
// system clock's real current month against the last month Compass was known to be open in -
// this is the actual "did the month change since last launch" check, independent of whether the
// user happens to open the app exactly on the 1st.
const newMonth = currentYM();
const lastSeen = localStorage.getItem(LS_LAST_SEEN_MONTH_KEY);
localStorage.setItem(LS_LAST_SEEN_MONTH_KEY, newMonth);
const justRolledOver = !!lastSeen && lastSeen !== newMonth;

export const useMonthRolloverStore = create<MonthRolloverState>((set) => ({
  justRolledOver,
  previousMonth: lastSeen,
  newMonth,
  modalShown: !justRolledOver,
  dismissModal: () => set({ modalShown: true }),
}));

export { monthLabel };
