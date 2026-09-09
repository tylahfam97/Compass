import { getDb, getRecurringRulesForProfile, getLoanAccountsForProfile, getCreditAccountsForProfile } from "./db";
import { detectRecurringCharges, computeDebtPayoffPlan } from "./agent";
import { latestBalancePerAccountSql } from "./reportingSql";
import {
  detectedChargeToRule, chargeMatchesRule, computeSpendingBaseline, toISODate, BASELINE_WEEKS,
  type ForecastRule, type SpendingBaseline,
} from "./forecast";
import type { DebtPayoffPlan } from "./types";

/**
 * Gathers everything `projectCashFlow` needs from the database. Kept apart from `forecast.ts`
 * so the projection maths stays pure and unit-testable.
 *
 * Checking/debit accounts only - see the scope note in forecast.ts.
 */

export interface ForecastInputs {
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
}

export async function getForecastInputs(profileId: number): Promise<ForecastInputs> {
  const db = await getDb();

  const baselineStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - BASELINE_WEEKS * 7);
    return toISODate(d);
  })();

  const [balanceRows, ruleRows, detectedCharges, spendRows] = await Promise.all([
    db.select<{ total: number; n: number }[]>(
      `SELECT COALESCE(SUM(${latestBalancePerAccountSql("a")}),0) as total, COUNT(*) as n
       FROM accounts a
       WHERE a.profile_id=? AND a.account_type='checking' AND a.excluded_from_insights=0`,
      [profileId]
    ),
    getRecurringRulesForProfile(profileId),
    detectRecurringCharges([profileId]),
    db.select<{ date: string; amount_cents: number; description: string }[]>(
      `SELECT t.date, t.amount_cents, t.description
       FROM transactions t
       JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id=? AND a.account_type='checking' AND a.excluded_from_insights=0
         AND t.amount_cents<0 AND t.date>=?
         AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))`,
      [profileId, baselineStart]
    ),
  ]);

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
    startingBalanceCents: balanceRows[0]?.total ?? 0,
    checkingAccountCount: balanceRows[0]?.n ?? 0,
    rules,
    detected,
    hasIncomeRule: activeRules.some((r) => r.amount_cents > 0),
    baseline: computeSpendingBaseline(discretionary),
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
