import { getDb, getLoanAccountsForProfile, getCreditAccountsForProfile } from "./db";
import { computeDebtPayoffPlan } from "./agent";
import { latestBalancePerAccountSql, incomeSumSql, expenseSumSql } from "./reportingSql";
import {
  chargeMatchesRule, computeSpendingBaseline, toISODate, BASELINE_WEEKS,
  type ForecastRule, type SpendingBaseline,
} from "./forecast";
import { getPlannedRules } from "./plannedRules";
import type { DebtPayoffPlan } from "./types";

export { getPlannedRules, getPlannedEvents, getFixedFlexibleInputs, type PlannedRules, type FixedFlexibleInputs } from "./plannedRules";

/**
 * Gathers everything `projectCashFlow` needs from the database. Kept apart from `forecast.ts`
 * so the projection maths stays pure and unit-testable.
 *
 * Checking/debit accounts only - see the scope note in forecast.ts.
 */

export interface ForecastInputs {
  balanceSources: { id: number; name: string; balance: number | null; date: string | null }[];
  startingBalanceCents: number;
  checkingAccountCount: number;
  /** Bills and income the user entered themselves. */
  rules: ForecastRule[];
  /** Charges inferred from transaction history, excluding any that duplicate a user rule. */
  detected: ForecastRule[];
  hasIncomeRule: boolean;
  /** Typical everyday spending derived from history, with scheduled bills excluded. Null when
   *  there's no usable history. */
  baseline: SpendingBaseline | null;
  /** What already happened in checking this calendar month (local dates, 1st through today).
   *  Already inside the balance, so it is shown beside the projection, never added to it. */
  monthToDate: MonthToDate;
}

export interface MonthToDate {
  /** YYYY-MM-01 of the current local month. */
  monthStart: string;
  incomeCents: number;
  spentCents: number;
  txCount: number;
  /** Newest checking transaction on file, any month - shows how current the import is. */
  lastImportedDate: string | null;
}

type Select = Pick<Awaited<ReturnType<typeof getDb>>, "select">;

/** Checking income and spending from the 1st of the current local month through today. Uses
 *  the same definitions as every report: transfers and card payments (categories 20, 29) move
 *  money between the user's own accounts, so they are neither income nor spending. */
export async function getMonthToDate(db: Select, profileId: number, today: Date = new Date()): Promise<MonthToDate> {
  const todayIso = toISODate(today);
  const monthStart = `${todayIso.slice(0, 7)}-01`;
  const [row] = await db.select<{ income: number | null; spent: number | null; tx_count: number; last_date: string | null }[]>(
    `SELECT ${incomeSumSql("t", "a")} as income, ${expenseSumSql("t")} as spent, COUNT(t.id) as tx_count,
       (SELECT MAX(t2.date) FROM transactions t2 JOIN accounts a2 ON a2.id=t2.account_id
        WHERE t2.profile_id=? AND a2.account_type='checking' AND a2.excluded_from_insights=0) as last_date
     FROM transactions t
     JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND a.account_type='checking' AND a.excluded_from_insights=0
       AND t.date>=? AND t.date<=?`,
    [profileId, profileId, monthStart, todayIso]
  );
  return {
    monthStart,
    incomeCents: row?.income ?? 0,
    spentCents: row?.spent ?? 0,
    txCount: row?.tx_count ?? 0,
    lastImportedDate: row?.last_date ?? null,
  };
}

export async function getForecastInputs(profileId: number): Promise<ForecastInputs> {
  const db = await getDb();

  const baselineStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - BASELINE_WEEKS * 7);
    return toISODate(d);
  })();

  const [balanceRows, planned, spendRows, monthToDate] = await Promise.all([
    db.select<{ id: number; name: string; balance: number | null; date: string | null }[]>(
      `SELECT a.id, a.name, ${latestBalancePerAccountSql("a")} as balance,
       (SELECT t.date FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL ORDER BY t.date DESC,t.id DESC LIMIT 1) as date
       FROM accounts a
       WHERE a.profile_id=? AND a.account_type='checking' AND a.excluded_from_insights=0`,
      [profileId]
    ),
    getPlannedRules(profileId),
    db.select<{ date: string; amount_cents: number; description: string }[]>(
      `SELECT t.date, t.amount_cents, t.description
       FROM transactions t
       JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id=? AND a.account_type='checking' AND a.excluded_from_insights=0
         AND t.amount_cents<0 AND t.date>=?
         AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))`,
      [profileId, baselineStart]
    ),
    getMonthToDate(db, profileId),
  ]);

  const { rules, detected, activeRules, detectedCharges } = planned;

  // Scheduled bills are already projected as events, so they must not count toward "typical
  // everyday spending" too. Detected charges are matched pre-dedup so a bill the user has
  // scheduled still gets excluded from the baseline.
  const scheduled = [
    ...activeRules.map((r) => ({ description: r.description, amount_cents: r.amount_cents })),
    ...detectedCharges.map((c) => ({ description: c.description, amount_cents: c.amount_cents })),
  ];
  const discretionary = spendRows.filter(
    (t) => !scheduled.some((s) => chargeMatchesRule({ description: t.description, amount_cents: t.amount_cents }, s))
  );

  return {
    balanceSources: balanceRows,
    startingBalanceCents: balanceRows.reduce((sum, account) => sum + (account.balance ?? 0), 0),
    checkingAccountCount: balanceRows.length,
    rules,
    detected,
    hasIncomeRule: planned.hasIncomeRule,
    baseline: computeSpendingBaseline(discretionary),
    monthToDate,
  };
}

/** The debts a spare-money surplus could be aimed at, plus the "minimum payments only" plan to
 *  compare any redirect against. Null when there's nothing outstanding to pay down. */
export interface DebtContext {
  plan: DebtPayoffPlan;
  debts: DebtInput[];
}

export interface DebtInput {
  id: number;
  name: string;
  balance_cents: number | null;
  interest_rate_bps: number | null;
  minimum_payment_cents: number | null;
}

export async function getDebtContext(profileId: number): Promise<DebtContext | null> {
  const [loans, credits] = await Promise.all([
    getLoanAccountsForProfile(profileId),
    getCreditAccountsForProfile(profileId),
  ]);

  // Debt balances are stored negative; a zero or positive one is already cleared.
  const debts: DebtInput[] = [...loans, ...credits]
    .filter((d) => (d.balance_cents ?? 0) < 0)
    .map((d) => ({
      id: d.id,
      name: d.name,
      balance_cents: d.balance_cents,
      interest_rate_bps: d.interest_rate_bps,
      minimum_payment_cents: d.minimum_payment_cents,
    }));

  if (debts.length === 0) return null;
  return { plan: await computeDebtPayoffPlan([profileId], debts), debts };
}
