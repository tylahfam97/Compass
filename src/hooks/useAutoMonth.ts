import { useState, useEffect } from "react";
import { getDb } from "@/lib/db";

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
 * Returns [month, setMonth] ("YYYY-MM").
 * On first mount, if the current month has no transactions, automatically
 * selects the most recent month that does so pages don't open blank.
 */
export function useAutoMonth() {
  const [month, setMonth] = useState(currentYM);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const db = await getDb();
      const [start, end] = monthBounds(currentYM());
      const [row] = await db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM transactions WHERE date>=? AND date<?",
        [start, end]
      );
      if ((row?.n ?? 0) === 0) {
        const [latest] = await db.select<{ month: string }[]>(
          "SELECT strftime('%Y-%m', date) as month FROM transactions ORDER BY date DESC LIMIT 1"
        );
        if (!cancelled && latest?.month) setMonth(latest.month);
      }
    }
    init().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []); // run once on mount

  return [month, setMonth] as const;
}
