import type { getDb } from "./db";
import { categoryNetSql } from "./reportingSql";

export interface BudgetDefinition {
  id: number;
  profile_id: number;
  category_id: number;
  category_name: string;
  category_parent_id: number | null;
  amount_cents: number;
  period: string;
  start_date: string;
  rollover: number;
  is_global: number;
}

interface BudgetPeriod {
  start: string;
  end: string;
  net: number;
  earned: number;
  available: number;
  covered: boolean;
  onTrack: boolean;
}

function budgetMonthBounds(month: string): [string, string] {
  const [year, monthNumber] = month.split("-").map(Number);
  return [`${month}-01`, `${monthNumber === 12 ? year + 1 : year}-${String(monthNumber === 12 ? 1 : monthNumber + 1).padStart(2, "0")}-01`];
}

export async function evaluateBudgetPeriod(
  db: Awaited<ReturnType<typeof getDb>>, budget: BudgetDefinition, profileIds: number[],
  start: string, end: string, insightsOnly = false,
): Promise<BudgetPeriod> {
  const income = budget.category_id === 1 || budget.category_parent_id === 1;
  const placeholders = profileIds.map(() => "?").join(",");
  const carryEnabled = budget.rollover && budget.period === "monthly" && !income;
  const historyStart = carryEnabled ? `${budget.start_date.slice(0, 7)}-01` : start;
  const rows = await db.select<{ month: string; net: number; earned: number; coverage: number }[]>(
    `SELECT strftime('%Y-%m', t.date) as month,
       ${categoryNetSql("selected", "a")} as net,
       COALESCE(SUM(CASE WHEN selected.amount_cents>0 AND a.account_type NOT IN ('credit','loan') THEN selected.amount_cents ELSE 0 END),0) as earned,
       COUNT(t.id) as coverage
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     LEFT JOIN transactions selected ON selected.id=t.id AND selected.category_id=?
     WHERE t.profile_id IN (${placeholders}) AND t.date>=? AND t.date<? ${insightsOnly ? "AND a.excluded_from_insights=0" : ""}
     GROUP BY month ORDER BY month`,
    [budget.category_id, ...profileIds, historyStart, end],
  );
  let carry = 0;
  let covered = start >= budget.start_date;
  if (carryEnabled) {
    let cursor = historyStart;
    while (cursor < start) {
      const row = rows.find((value) => value.month === cursor.slice(0, 7));
      if (!row?.coverage) covered = false;
      carry = budgetCarryCents(budget.amount_cents + carry, row?.net ?? 0);
      cursor = budgetMonthBounds(cursor.slice(0, 7))[1];
    }
  }
  const selected = rows.filter((row) => row.month >= start.slice(0, 7));
  const net = selected.reduce((sum, row) => sum + row.net, 0);
  const earned = selected.reduce((sum, row) => sum + row.earned, 0);
  covered = covered && selected.some((row) => row.coverage > 0);
  const available = budget.amount_cents + carry;
  return { start, end, net, earned, available, covered, onTrack: covered && (income ? earned >= available : net <= available) };
}

export function budgetCarryCents(availableCents: number, netUsedCents: number): number {
  return Math.max(0, availableCents - Math.max(0, netUsedCents));
}

export function completedBudgetMonths(count: number, today = new Date()): string[] {
  const cursor = new Date(today);
  cursor.setDate(1);
  return Array.from({ length: count }, () => {
    cursor.setMonth(cursor.getMonth() - 1);
    return `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
  });
}