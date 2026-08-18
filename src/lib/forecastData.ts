import { getDb, getRecurringRulesForProfile } from "./db";
import { detectRecurringCharges } from "./agent";
import { expenseSumSql, latestBalancePerAccountSql } from "./reportingSql";
import { detectedChargeToRule, chargeMatchesRule, type ForecastRule } from "./forecast";

/**
 * Gathers everything `projectCashFlow` needs from the database. Kept apart from `forecast.ts`
 * so the projection maths stays pure and unit-testable.
 *
 * Checking/debit accounts only - see the scope note in forecast.ts.
 */

/** Below this, a projection would be extrapolating from noise, so the Plan page explains
 *  instead of guessing. */
export const MIN_MONTHS_FOR_FORECAST = 2;

/** Months of history averaged to derive the everyday-spending baseline. */
const BASELINE_MONTHS = 3;

export interface ForecastInputs {
  startingBalanceCents: number;
  checkingAccountCount: number;
  /** Bills and income the user entered themselves. */
  rules: ForecastRule[];
  /** Charges inferred from transaction history, excluding any that duplicate a user rule. */
  detected: ForecastRule[];
  avgMonthlyExpenseCents: number;
  monthsOfData: number;
  hasIncomeRule: boolean;
}

function monthsAgoStart(months: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function currentMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export async function getForecastInputs(profileId: number): Promise<ForecastInputs> {
  const db = await getDb();

  const [balanceRows, monthRows, ruleRows, detectedCharges] = await Promise.all([
    db.select<{ total: number; n: number }[]>(
      `SELECT COALESCE(SUM(${latestBalancePerAccountSql("a")}),0) as total, COUNT(*) as n
       FROM accounts a
       WHERE a.profile_id=? AND a.account_type='checking' AND a.excluded_from_insights=0`,
      [profileId]
    ),
    db.select<{ months: number }[]>(
      "SELECT COUNT(DISTINCT substr(date,1,7)) as months FROM transactions WHERE profile_id=?",
      [profileId]
    ),
    getRecurringRulesForProfile(profileId),
    detectRecurringCharges([profileId]),
  ]);

  // Averaged over completed months only - the current month is partial and would drag the
  // baseline down every time the app is opened early in a month.
  const spendRows = await db.select<{ ym: string; total: number }[]>(
    `SELECT substr(t.date,1,7) as ym, ${expenseSumSql("t")} as total
     FROM transactions t
     JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND a.account_type='checking'
       AND a.excluded_from_insights=0
       AND t.date>=? AND t.date<?
     GROUP BY ym`,
    [profileId, monthsAgoStart(BASELINE_MONTHS), currentMonthStart()]
  );

  const avgMonthlyExpenseCents =
    spendRows.length > 0
      ? Math.round(spendRows.reduce((sum, r) => sum + r.total, 0) / spendRows.length)
      : 0;

  const activeRules = ruleRows.filter((r) => r.active);
  const rules: ForecastRule[] = activeRules.map((r) => ({
    id: r.id,
    description: r.description,
    amount_cents: r.amount_cents,
    source: "rule",
    cadence: r.cadence,
    day_of_month: r.day_of_month,
    day_of_week: r.day_of_week,
    start_date: r.start_date,
    category_name: r.category_name ?? null,
    category_color: r.category_color ?? null,
  }));

  // A charge the user has already scheduled would otherwise be projected twice - matched
  // loosely, since a hand-typed "SoFi" and the bank's full ACH descriptor are the same bill.
  const detected: ForecastRule[] = detectedCharges
    .filter((c) => !activeRules.some((r) => chargeMatchesRule(c, r)))
    .map(detectedChargeToRule);

  return {
    startingBalanceCents: balanceRows[0]?.total ?? 0,
    checkingAccountCount: balanceRows[0]?.n ?? 0,
    rules,
    detected,
    avgMonthlyExpenseCents,
    monthsOfData: monthRows[0]?.months ?? 0,
    hasIncomeRule: activeRules.some((r) => r.amount_cents > 0),
  };
}
