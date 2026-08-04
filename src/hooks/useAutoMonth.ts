import { useCallback, useEffect, useRef } from "react";
import { useMonthNavStore } from "@/stores/monthNavStore";
import { useProfileStore } from "@/stores/profileStore";

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Returns [month, setMonth] ("YYYY-MM") for the page identified by `pageKey`. Defaults to the
 * real current month - always, with no silent "jump to whichever month has data" override, so
 * views never quietly show a stale month. The selection is remembered in a shared store (not
 * local useState), so navigating to another tab and back restores whatever month you were on
 * instead of resetting - except on profile switch, which wipes every page's remembered month so
 * a new (or different) profile never inherits a stale month left over from the last one.
 *
 * Pass `initialMonth` to force-jump to a specific month right now (e.g. arriving here from the
 * import flow's "View Transactions" with a target month) - this always wins over a remembered
 * month and becomes the new remembered value going forward.
 */
export function useAutoMonth(pageKey: string, initialMonth?: string) {
  const storedMonth = useMonthNavStore((s) => s.months[pageKey]);
  const setStoredMonth = useMonthNavStore((s) => s.setMonth);
  const resetAllMonths = useMonthNavStore((s) => s.resetAll);
  const activeProfileId = useProfileStore((s) => s.activeProfile?.id);
  const lastProfileId = useRef(activeProfileId);

  useEffect(() => {
    if (initialMonth) setStoredMonth(pageKey, initialMonth);
  }, [initialMonth, pageKey, setStoredMonth]);

  useEffect(() => {
    if (lastProfileId.current !== activeProfileId) {
      lastProfileId.current = activeProfileId;
      resetAllMonths();
    }
  }, [activeProfileId, resetAllMonths]);

  const month = initialMonth ?? storedMonth ?? currentYM();
  const setMonth = useCallback((m: string) => setStoredMonth(pageKey, m), [pageKey, setStoredMonth]);

  return [month, setMonth] as const;
}

