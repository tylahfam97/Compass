import type { getDb } from "./db";
import { categorySpendSql, incomeSumSql, expenseSumSql } from "./reportingSql";
import { evaluateBudgetPeriod, completedBudgetMonths, type BudgetDefinition } from "./budgetMetrics";

/**
 * Goal evaluation, shared by the Goals page and the insight engine. The SQL is the Goals page's
 * loader moved here unchanged; the small pure helpers underneath are what the insights need
 * (is a goal on track, how far is it, when does it land at the current pace).
 */

export type GoalType =
  | "net_savings"
  | "reduce_spend"
  | "increase_income"
  | "savings_target"
  | "balance_floor"
  | "budget_streak"
  | "savings_rate_habit"
  | "debt_paydown";

export interface GoalRow {
  id: number;
  name: string;
  type: GoalType;
  category_id: number | null;
  account_id: number | null;
  target_cents: number;
  target_months: number | null;
  active: number;
  created_at: string;
  category_name?: string;
  category_color?: string;
  account_name?: string;
  account_kind?: string;
}

export interface GoalWithProgress extends GoalRow {
  current_cents: number;
  current_streak: number;
  on_track: boolean;
  pct: number;
  weeklyAmounts: number[];
  noBalanceData?: boolean;
  noBudgetData?: boolean;
}

export const STREAK_TYPES = new Set<GoalType>(["budget_streak", "savings_rate_habit"]);
export const CLASSIC_TYPES = new Set<GoalType>(["net_savings", "reduce_spend", "increase_income"]);

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [`${y}-${String(m).padStart(2, "0")}-01`, localIso(new Date(y, m, 1))];
}

export function daysInMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export function daysElapsed(ym: string, today: Date = new Date()): number {
  const [y, m] = ym.split("-").map(Number);
  const isCurrentMonth = today.getFullYear() === y && today.getMonth() + 1 === m;
  if (!isCurrentMonth) return daysInMonth(ym);
  return today.getDate();
}

export function currentWeekBounds(today: Date = new Date()): [string, string] {
  const dow = (today.getDay() + 6) % 7;
  const mon = new Date(today);
  mon.setDate(today.getDate() - dow);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 7);
  return [localIso(mon), localIso(sun)];
}

export function recentMonths(n: number, today: Date = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(today);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export interface GoalStatusInput {
  type: GoalType;
  target_cents: number;
  target_months: number | null;
  current: number;
  streak: number;
  noBalanceData?: boolean;
}

/** Progress as a percentage, clamped to 150 so a blown target does not stretch the bar forever. */
export function goalPct(input: GoalStatusInput & { debtPaydownPct?: number | null }): number {
  if (input.type === "debt_paydown") return input.debtPaydownPct ?? 0;
  const targetForPct = STREAK_TYPES.has(input.type) ? (input.target_months ?? 3) * 100 : input.target_cents;
  return targetForPct > 0 ? Math.min(150, Math.round((input.current / targetForPct) * 100)) : 0;
}

export function goalIsOnTrack(input: GoalStatusInput): boolean {
  const { type, target_cents, target_months, current, streak, noBalanceData } = input;
  if (type === "reduce_spend") return current <= target_cents;
  if (type === "balance_floor") return current >= target_cents && !noBalanceData;
  if (type === "debt_paydown") return current <= target_cents && !noBalanceData;
  if (STREAK_TYPES.has(type)) return streak >= (target_months ?? 3);
  return current >= target_cents;
}

/** Whole months until `remainingCents` is covered at `monthlyPaceCents`; 0 when already there, null when not gaining. */
export function projectGoalCompletion(remainingCents: number, monthlyPaceCents: number): number | null {
  if (remainingCents <= 0) return 0;
  if (monthlyPaceCents <= 0) return null;
  return Math.ceil(remainingCents / monthlyPaceCents);
}

/** Average monthly change between the first and last point of a dated balance series (positive = falling), or null under `minDays` of span. */
export function monthlyPaceFromBalances(points: { date: string; value: number }[], minDays = 60): { paceCents: number; days: number; changeCents: number } | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const days = Math.round((new Date(`${last.date}T00:00:00`).getTime() - new Date(`${first.date}T00:00:00`).getTime()) / 86_400_000);
  if (days < minDays) return null;
  const changeCents = Math.round(Math.abs(first.value) - Math.abs(last.value));
  return { paceCents: Math.round(changeCents / (days / 30.4)), days, changeCents };
}

// ── Database evaluation ──────────────────────────────────────────────────────

export async function evaluateGoals(
  db: Awaited<ReturnType<typeof getDb>>,
  profileId: number,
  month: string,
  today: Date = new Date()
): Promise<GoalWithProgress[]> {
  const [start, end] = monthBounds(month);

  const rows = await db.select<GoalRow[]>(
    `SELECT g.*, c.name as category_name, c.color as category_color,
            acc.name as account_name, acc.account_type as account_kind
     FROM goals g
     LEFT JOIN categories c ON g.category_id=c.id
     LEFT JOIN accounts acc ON g.account_id=acc.id
     WHERE g.active=1 AND g.profile_id=? ORDER BY g.created_at`,
    [profileId]
  );

  const withProgress: GoalWithProgress[] = await Promise.all(
    rows.map(async (g) => {
      let current = 0;
      let streak = 0;
      let noBalanceData = false;
      let noBudgetData = false;
      let debtPaydownPct: number | null = null;

      if (g.type === "net_savings") {
        const [r] = await db.select<{ v: number }[]>(
          `SELECT COALESCE(SUM(CASE WHEN a.account_type='credit' AND t.amount_cents>0 THEN 0 ELSE t.amount_cents END),0) as v
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.date<? AND t.profile_id=? AND (t.category_id IS NULL OR t.category_id NOT IN (20,29)) AND a.account_type!='loan'`,
          [start, end, profileId]
        );
        current = r?.v ?? 0;

      } else if (g.type === "reduce_spend") {
        const extra = g.category_id ? " AND t.category_id=?" : "";
        const params: unknown[] = g.category_id
          ? [start, end, profileId, g.category_id]
          : [start, end, profileId];
        const [r] = await db.select<{ v: number }[]>(
          `SELECT COALESCE(${categorySpendSql()},0) as v
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.date<? AND t.profile_id=? AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))${extra}`,
          params
        );
        current = r?.v ?? 0;

      } else if (g.type === "increase_income") {
        const extra = g.category_id ? " AND t.category_id=?" : "";
        const params: unknown[] = g.category_id
          ? [start, end, profileId, g.category_id]
          : [start, end, profileId];
        const [r] = await db.select<{ v: number }[]>(
          `SELECT COALESCE(SUM(t.amount_cents),0) as v FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.date<? AND t.profile_id=? AND t.amount_cents>0 AND a.account_type NOT IN ('credit','loan')${extra}`,
          params
        );
        current = r?.v ?? 0;

      } else if (g.type === "savings_target") {
        // Sum of positive monthly nets since goal creation
        const [r] = await db.select<{ v: number }[]>(
          `SELECT COALESCE(SUM(net),0) as v FROM (
             SELECT strftime('%Y-%m',t.date) as mo,
               ${incomeSumSql()} - ${expenseSumSql()} as net
             FROM transactions t JOIN accounts a ON a.id=t.account_id
             WHERE t.profile_id=? AND t.date>=?
             GROUP BY mo
           ) WHERE net>0`,
          [profileId, g.created_at.slice(0, 10)]
        );
        current = r?.v ?? 0;

      } else if (g.type === "balance_floor") {
        // "Buffer" goal: sum the LATEST known balance of every checking account (not just
        // whichever account happens to have the most recent transaction row) - a user with
        // multiple bank statements/accounts should have all of them count toward the buffer.
        const checkingBalRows = await db.select<{ account_id: number; balance_cents: number | null }[]>(
          `SELECT a.id as account_id,
             (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
              ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
           FROM accounts a WHERE a.profile_id=? AND a.account_type='checking' AND a.hidden_from_dashboard=0`,
          [profileId]
        );
        const trackedChecking = checkingBalRows.filter((r) => r.balance_cents !== null);
        if (trackedChecking.length === 0) { noBalanceData = true; current = 0; }
        else current = trackedChecking.reduce((s, r) => s + (r.balance_cents ?? 0), 0);

      } else if (g.type === "debt_paydown") {
        // A specific credit card/loan (g.account_id set), or every credit card + loan
        // combined (g.account_id null) - either way, sum each account's LATEST balance.
        const acctIds = g.account_id
          ? [g.account_id]
          : (await db.select<{ id: number }[]>(
              "SELECT id FROM accounts WHERE profile_id=? AND account_type IN ('credit','loan') AND hidden_from_dashboard=0",
              [profileId]
            )).map((r) => r.id);

        if (acctIds.length === 0) {
          noBalanceData = true;
        } else {
          const ph = acctIds.map(() => "?").join(",");
          const latestRows = await db.select<{ account_id: number; balance_cents: number | null }[]>(
            `SELECT a.id as account_id,
               (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
                ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
             FROM accounts a WHERE a.id IN (${ph})`,
            acctIds
          );
          const trackedLatest = latestRows.filter((r) => r.balance_cents !== null);
          if (trackedLatest.length === 0) {
            noBalanceData = true;
          } else {
            current = Math.abs(trackedLatest.reduce((s, r) => s + (r.balance_cents ?? 0), 0));

            // Starting debt (as of goal creation, falling back to each account's very first
            // known balance) drives the progress bar - comparing current owed directly to
            // the target ceiling isn't a meaningful "% complete" on its own, since current
            // owed is usually far larger than the target for most of a paydown goal's life.
            const createdDate = g.created_at.slice(0, 10);
            const startRows = await db.select<{ account_id: number; balance_cents: number | null }[]>(
              `SELECT a.id as account_id,
                 (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL AND t.date<=?
                  ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
               FROM accounts a WHERE a.id IN (${ph})`,
              [createdDate, ...acctIds]
            );
            const earliestRows = await db.select<{ account_id: number; balance_cents: number | null }[]>(
              `SELECT a.id as account_id,
                 (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
                  ORDER BY t.date ASC, t.id ASC LIMIT 1) as balance_cents
               FROM accounts a WHERE a.id IN (${ph})`,
              acctIds
            );
            const startingDebt = Math.abs(
              acctIds.reduce((sum, id) => {
                const viaCreated = startRows.find((r) => r.account_id === id)?.balance_cents;
                const viaEarliest = earliestRows.find((r) => r.account_id === id)?.balance_cents;
                return sum + (viaCreated ?? viaEarliest ?? 0);
              }, 0)
            );
            debtPaydownPct = startingDebt > g.target_cents
              ? Math.min(150, Math.max(0, Math.round(((startingDebt - current) / (startingDebt - g.target_cents)) * 100)))
              : (current <= g.target_cents ? 100 : 0);
          }
        }

      } else if (g.type === "budget_streak") {
        // Count consecutive months (newest first) where spend <= budget
        if (!g.category_id) { noBudgetData = true; }
        else {
          const [budgetRow] = await db.select<BudgetDefinition[]>(
            "SELECT b.*,c.name as category_name,c.parent_id as category_parent_id FROM budgets b JOIN categories c ON c.id=b.category_id WHERE b.profile_id=? AND b.category_id=? AND b.is_global=0 AND b.period='monthly' ORDER BY b.created_at DESC LIMIT 1",
            [profileId, g.category_id]
          );
          if (!budgetRow) { noBudgetData = true; }
          else {
            const months12 = completedBudgetMonths(12, today);
            let s = 0;
            for (const mo of months12) {
              const [ms, me] = monthBounds(mo);
              if (ms < budgetRow.start_date) { if (s === 0) noBudgetData = true; break; }
              const evaluation = await evaluateBudgetPeriod(db, budgetRow, [profileId], ms, me);
              if (!evaluation.covered) { if (s === 0) noBudgetData = true; break; }
              if (!evaluation.onTrack) break;
              s++;
            }
            streak = s;
            current = s * 100; // use cents slot to store streak*100 for pct calc
          }
        }

      } else if (g.type === "savings_rate_habit") {
        const targetRate = g.target_cents / 100; // e.g. 2000 -> 20%
        const months12 = recentMonths(12, today);
        let s = 0;
        for (const mo of months12) {
          const [ms, me] = monthBounds(mo);
          const [r] = await db.select<{ income: number; expenses: number }[]>(
            `SELECT
               ${incomeSumSql()} as income,
               ${expenseSumSql()} as expenses
             FROM transactions t JOIN accounts a ON a.id=t.account_id
             WHERE t.profile_id=? AND t.date>=? AND t.date<?`,
            [profileId, ms, me]
          );
          if (!r || r.income === 0) break;
          const rate = ((r.income - r.expenses) / r.income) * 100;
          if (rate < targetRate) break;
          s++;
        }
        streak = s;
        current = s * 100;
      }

      const status = { type: g.type, target_cents: g.target_cents, target_months: g.target_months, current, streak, noBalanceData };
      return {
        ...g,
        current_cents: current,
        current_streak: streak,
        on_track: goalIsOnTrack(status),
        pct: goalPct({ ...status, debtPaydownPct }),
        weeklyAmounts: [],
        noBalanceData,
        noBudgetData,
      };
    })
  );

  // Attach weekly amounts for reduce_spend goals
  const [weekStart, weekEnd] = currentWeekBounds(today);
  const weeklyRows = await db.select<{ category_id: number | null; dow: number; total: number }[]>(
    `SELECT category_id,
            (strftime('%w', date) + 6) % 7 as dow,
            SUM(ABS(amount_cents)) as total
     FROM transactions
     WHERE date>=? AND date<? AND profile_id=? AND amount_cents<0
     GROUP BY category_id, dow`,
    [weekStart, weekEnd, profileId]
  );
  const weeklyAllCats = Array(7).fill(0);
  const weeklyByCat: Record<number, number[]> = {};
  for (const row of weeklyRows) {
    weeklyAllCats[row.dow] = (weeklyAllCats[row.dow] ?? 0) + row.total;
    if (row.category_id !== null) {
      if (!weeklyByCat[row.category_id]) weeklyByCat[row.category_id] = Array(7).fill(0);
      weeklyByCat[row.category_id][row.dow] = row.total;
    }
  }
  return withProgress.map((g) => ({
    ...g,
    weeklyAmounts:
      g.type === "reduce_spend"
        ? g.category_id
          ? weeklyByCat[g.category_id] ?? Array(7).fill(0)
          : weeklyAllCats
        : Array(7).fill(0),
  }));
}
