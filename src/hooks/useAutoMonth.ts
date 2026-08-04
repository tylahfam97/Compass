<<<<<<< HEAD
import { useCallback, useEffect } from "react";
import { useMonthNavStore } from "@/stores/monthNavStore";
=======
import { useState, useEffect } from "react";
import { useProfileStore } from "@/stores/profileStore";
>>>>>>> d54c2fc (hotfix: added month default to current month)

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
<<<<<<< HEAD
 * Returns [month, setMonth] ("YYYY-MM") for the page identified by `pageKey`. Defaults to the
 * real current month - always, with no silent "jump to whichever month has data" override, so
 * views never quietly show a stale month. The selection is remembered in a shared store (not
 * local useState), so navigating to another tab and back restores whatever month you were on
 * instead of resetting.
 *
 * Pass `initialMonth` to force-jump to a specific month right now (e.g. arriving here from the
 * import flow's "View Transactions" with a target month) - this always wins over a remembered
 * month and becomes the new remembered value going forward.
=======
 * Returns [month, setMonth] ("YYYY-MM"), scoped to the active profile - always defaults to
 * (and resets to, on profile switch) the real current month, regardless of whether that
 * profile has any transactions yet.
 *
 * Pass `initialMonth` to seed the picker with a specific month on first render (e.g.
 * navigating here from the import flow).
>>>>>>> d54c2fc (hotfix: added month default to current month)
 */
export function useAutoMonth(pageKey: string, initialMonth?: string) {
  const storedMonth = useMonthNavStore((s) => s.months[pageKey]);
  const setStoredMonth = useMonthNavStore((s) => s.setMonth);

  useEffect(() => {
<<<<<<< HEAD
    if (initialMonth) setStoredMonth(pageKey, initialMonth);
  }, [initialMonth, pageKey, setStoredMonth]);

  const month = initialMonth ?? storedMonth ?? currentYM();
  const setMonth = useCallback((m: string) => setStoredMonth(pageKey, m), [pageKey, setStoredMonth]);
=======
    if (!activeProfile) return;
    setMonth(currentYM());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id]); // re-run when profile changes
>>>>>>> d54c2fc (hotfix: added month default to current month)

  return [month, setMonth] as const;
}

