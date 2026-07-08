import { useState, useEffect } from "react";
import { getDb } from "@/lib/db";
import { useProfileStore } from "@/stores/profileStore";

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

/**
 * Returns [month, setMonth] ("YYYY-MM"), scoped to the active profile.
 * On profile change, if the current month has no transactions for that
 * profile, automatically selects the most recent month that does.
 *
 * Pass `initialMonth` to seed the picker with a specific month on first
 * render (e.g. navigating here from the import flow).
 */
export function useAutoMonth(initialMonth?: string) {
  const [month, setMonth] = useState(() => initialMonth ?? currentYM());
  const activeProfile = useProfileStore((s) => s.activeProfile);

  useEffect(() => {
    if (!activeProfile) return;
    let cancelled = false;
    async function init() {
      const db = await getDb();
      const [start, end] = monthBounds(currentYM());
      const [row] = await db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM transactions WHERE date>=? AND date<? AND profile_id=?",
        [start, end, activeProfile!.id]
      );
      if ((row?.n ?? 0) === 0) {
        const [latest] = await db.select<{ month: string }[]>(
          "SELECT strftime('%Y-%m', date) as month FROM transactions WHERE profile_id=? ORDER BY date DESC LIMIT 1",
          [activeProfile!.id]
        );
        if (!cancelled && latest?.month) setMonth(latest.month);
        else if (!cancelled) setMonth(currentYM());
      }
    }
    init().catch(console.error);
    return () => { cancelled = true; };
  }, [activeProfile?.id]); // re-run when profile changes

  return [month, setMonth] as const;
}

