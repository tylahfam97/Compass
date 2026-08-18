import { getDb } from "./db";
import { incomeSumSql, expenseSumSql, categorySpendSql } from "./reportingSql";

/**
 * A short retrospective on a finished month, shown once when Compass notices the calendar has
 * turned over. Every figure uses the shared reporting SQL so the recap can never disagree with
 * the Dashboard or Trends about the same month.
 */

export interface MonthInReview {
  month: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  /** Net as a share of income, or null when there was no income to divide by. */
  savingsRate: number | null;
  transactionCount: number;
  topCategory: { name: string; color: string | null; totalCents: number } | null;
  /** Change in total spend against the month before, or null with nothing to compare to. */
  spendChangeCents: number | null;
  budgetsHeld: number;
  budgetsTotal: number;
}

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [`${y}-${String(m).padStart(2, "0")}-01`, new Date(y, m, 1).toISOString().split("T")[0]];
}

function prevYM(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function getMonthInReview(profileId: number, month: string): Promise<MonthInReview | null> {
  const db = await getDb();
  const [start, end] = monthBounds(month);
  const [prevStart, prevEnd] = monthBounds(prevYM(month));

  const [totals, topCats, prevTotals, budgets] = await Promise.all([
    db.select<{ income: number; expense: number; n: number }[]>(
      `SELECT ${incomeSumSql("t", "a")} as income, ${expenseSumSql("t")} as expense, COUNT(*) as n
       FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id=? AND t.date>=? AND t.date<?`,
      [profileId, start, end]
    ),
    db.select<{ name: string; color: string | null; total: number }[]>(
      `SELECT c.name, c.color, ${categorySpendSql("t", "a")} as total
       FROM transactions t
       JOIN accounts a ON a.id=t.account_id
       LEFT JOIN categories c ON c.id=t.category_id
       WHERE t.profile_id=? AND t.date>=? AND t.date<?
         AND t.category_id!=1 AND (c.parent_id IS NULL OR c.parent_id!=1)
       GROUP BY t.category_id
       HAVING total > 0
       ORDER BY total DESC LIMIT 1`,
      [profileId, start, end]
    ),
    db.select<{ expense: number }[]>(
      `SELECT ${expenseSumSql("t")} as expense
       FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id=? AND t.date>=? AND t.date<?`,
      [profileId, prevStart, prevEnd]
    ),
    db.select<{ held: number; total: number }[]>(
      `SELECT
         SUM(CASE WHEN spent <= b.amount_cents THEN 1 ELSE 0 END) as held,
         COUNT(*) as total
       FROM (
         SELECT b.id, b.amount_cents,
                COALESCE((SELECT ${categorySpendSql("t", "a")}
                          FROM transactions t JOIN accounts a ON a.id=t.account_id
                          WHERE t.category_id=b.category_id AND t.profile_id=?
                            AND t.date>=? AND t.date<?),0) as spent
         FROM budgets b
         JOIN categories c ON c.id=b.category_id
         WHERE b.profile_id=? AND b.period='monthly' AND b.start_date<=?
           AND c.id!=1 AND (c.parent_id IS NULL OR c.parent_id!=1)
       ) b`,
      [profileId, start, end, profileId, start]
    ),
  ]);

  const income = totals[0]?.income ?? 0;
  const expense = totals[0]?.expense ?? 0;
  const count = totals[0]?.n ?? 0;
  if (count === 0) return null; // nothing happened; a recap would be noise

  const prevExpense = prevTotals[0]?.expense ?? 0;
  const top = topCats[0];

  return {
    month,
    incomeCents: income,
    expenseCents: expense,
    netCents: income - expense,
    savingsRate: income > 0 ? (income - expense) / income : null,
    transactionCount: count,
    topCategory: top ? { name: top.name ?? "Uncategorized", color: top.color, totalCents: top.total } : null,
    spendChangeCents: prevExpense > 0 ? expense - prevExpense : null,
    budgetsHeld: budgets[0]?.held ?? 0,
    budgetsTotal: budgets[0]?.total ?? 0,
  };
}
