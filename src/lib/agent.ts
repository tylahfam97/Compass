import { getDb, getLoanAccountsForProfile, getCreditAccountsForProfile, getLoanBalanceHistory } from "./db";
import type { Insight, HealthScore, CreditCardHealthScore, DebtPayoffPlan, DebtPayoffSimDebt, DebtPayoffCustomResult, DebtPayoffCategoryBreakdown } from "./types";
import { computeNetWorth, computeInvestmentReturn, latestHoldingPerAccount } from "./netWorth";
import { incomeSumSql, expenseSumSql, categorySpendSql, latestBalancePerAccountSql } from "./reportingSql";
import { AVG_US_CREDIT_CARD_DEBT_CENTS, AVG_US_MARKET_RETURN_PCT, scoreGrade } from "./benchmarks";
import { composeInsightText } from "./voice";
import { getRemembered, remember } from "./voiceMemory";
import { chargeKey } from "./hiddenCharges";
import { formatCurrencyWhole as formatCents, formatCurrency, formatDate } from "./utils";
import { evaluateBudgetPeriod, type BudgetDefinition } from "./budgetMetrics";
import { expandOccurrences, projectCashFlow, toISODate, chargeMatchesRule } from "./forecast";
import { getPlannedRules, plannedMonthlyIncomeCents, plannedMonthlyBillsCents, getFixedFlexibleInputs } from "./plannedRules";
import { detectRecurringCharges } from "./recurringCharges";
import { loadScenario } from "./planScenario";
import { merchantKey } from "./merchants";
import { detectPriceChange, isNewRecurring, findAnnualCharges } from "./recurringDetection";
import { findMissingScheduled, billsDueWithin, nextIncomeEvent } from "./insights/scheduled";
import { findDuplicateCharges, findFrequentMerchants } from "./insights/duplicates";
import { summarizeFixedFlexible, monthsWithIncome, countNoSpendDays, paydayBurstShare, classifyExpense, isIncomeTxn, type ShapeTxn, type ScheduledLike } from "./insights/shape";
import { rankInsights } from "./insights/rank";
import { evaluateGoals, projectGoalCompletion, monthlyPaceFromBalances } from "./goals";

export { detectRecurringCharges } from "./recurringCharges";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** [first day, first day of the next month), both as local dates. */
function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [`${ym}-01`, toISODate(new Date(y, m, 1))];
}

/** Returns the N most recent "YYYY-MM" month strings (newest first) */
function recentMonths(n: number): string[] {
  const months: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return months;
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round((new Date(`${toIso}T00:00:00`).getTime() - new Date(`${fromIso}T00:00:00`).getTime()) / 86_400_000);
}

function describeDays(n: number): string {
  return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

/** "Sep 12" */
function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(`${iso}T12:00:00`));
}

/** "September" for a YYYY-MM key. */
function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y, m - 1, 1));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "A, B and C" */
function listClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function quarterKey(d: Date): string {
  return `${d.getFullYear()}Q${Math.floor(d.getMonth() / 3) + 1}`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Savings rate across a set of months: total net dollars over total income dollars.
 *
 * Deliberately a ratio of sums rather than the mean of each month's own ratio - averaging
 * ratios weights every month equally regardless of size, so one unusually low-income month
 * (a tiny denominator) produces an extreme value that dominates the result and disagrees with
 * what the underlying dollars, and the savings-rate chart, actually show.
 * Returns null when there's no income to divide by.
 */
export function aggregateSavingsRate(months: { income: number; expenses: number }[]): number | null {
  const income = months.reduce((s, m) => s + m.income, 0);
  if (income <= 0) return null;
  return (income - months.reduce((s, m) => s + m.expenses, 0)) / income;
}

// The savings rate is "income that didn't go back out": every dollar earned, minus every dollar
// spent, whatever it was spent on. Definitions live in reportingSql.ts because the pages report
// the same numbers and any drift between them is visible to the user as a mismatch.
const INCOME_SUM_SQL = incomeSumSql();
const EXPENSE_SUM_SQL = expenseSumSql();

/** Standard amortization payoff estimate in months, given a positive balance and monthly
 *  payment (both in dollars) and a monthly interest rate (decimal, e.g. 0.015 for 1.5%/mo).
 *  Returns null if the payment doesn't even cover the interest charge (balance would never
 *  shrink at that payment) or the inputs are invalid. */
function estimatePayoffMonths(balance: number, monthlyRate: number, payment: number): number | null {
  if (balance <= 0 || payment <= 0) return null;
  if (monthlyRate <= 0) return balance / payment;
  const interestPortion = balance * monthlyRate;
  if (payment <= interestPortion) return null; // payment doesn't cover interest
  const months = -Math.log(1 - interestPortion / payment) / Math.log(1 + monthlyRate);
  return Number.isFinite(months) ? months : null;
}

/** One row of the shared recent-transactions window every JS-side rule reads from. */
interface RecentRow {
  id: number;
  account_id: number;
  account_type: string;
  account_name: string;
  date: string;
  description: string;
  amount_cents: number;
  category_id: number | null;
}

const isExcludedCategory = (c: number | null) => c === 20 || c === 29;
const INTEREST_RE = /INTEREST|FINANCE CHARGE/i;
const NOT_INTEREST_RE = /INTEREST FREE|REVERSAL|REFUND/i;
const DUPLICATE_SKIP_RE = /ATM|CASH|WITHDRAW|TRANSFER|PAYMENT|TIP/i;

// ─── Main analysis function ───────────────────────────────────────────────────

async function _insightsForProfile(profileId: number): Promise<Insight[]> {
  const db = await getDb();
  const insights: Insight[] = [];
  const today = new Date();
  const todayIso = toISODate(today);

  // ── 0. Current account balance (liquid cash only - checking, not credit) ──
  // Summed per account: a bare `ORDER BY date DESC LIMIT 1` would report only whichever
  // checking account happened to be updated most recently and ignore the rest.
  const [balanceRow] = await db.select<{ balance_cents: number; date: string | null }[]>(
    `SELECT COALESCE(SUM(${latestBalancePerAccountSql()}), 0) as balance_cents,
            MAX((SELECT bt.date FROM transactions bt WHERE bt.account_id=a.id AND bt.balance_cents IS NOT NULL
                 ORDER BY bt.date DESC, bt.id DESC LIMIT 1)) as date
     FROM accounts a
     WHERE a.profile_id=? AND a.account_type='checking' AND a.excluded_from_insights=0`,
    [profileId]
  );
  const balanceKnown = balanceRow?.balance_cents != null && !!balanceRow.date;

  // ── 1. How many months of data do we have? ──────────────────────────────
  const [dataRange] = await db.select<{ months: number }[]>(
    `SELECT COUNT(DISTINCT strftime('%Y-%m', date)) as months
     FROM transactions WHERE profile_id=?`,
    [profileId]
  );
  const monthCount = dataRange?.months ?? 0;
  if (monthCount < 1) return []; // nothing to analyse

  const months12 = recentMonths(12);
  const thisMonth = months12[0];
  const [thisStart, thisEnd] = monthBounds(thisMonth);
  const daysInThisMonth = daysBetweenIso(thisStart, thisEnd);

  // ── 2. Per-month summaries ───────────────────────────────────────────────
  const monthlySummaries = await db.select<{
    month: string;
    income: number;
    expenses: number;
  }[]>(
    `SELECT strftime('%Y-%m', t.date) as month,
            ${INCOME_SUM_SQL} as income,
            ${EXPENSE_SUM_SQL} as expenses
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND a.excluded_from_insights=0 GROUP BY month ORDER BY month DESC LIMIT 12`,
    [profileId]
  );

  // Whole months only. The current month is partly elapsed, so its totals aren't comparable to
  // a full month and must never be averaged in alongside them.
  const currentSummary = monthlySummaries[0]?.month === thisMonth ? monthlySummaries[0] : null;
  const completeMonths = currentSummary ? monthlySummaries.slice(1) : monthlySummaries;
  const lastComplete = completeMonths[0] ?? null;
  const avgOf = (rows: { expenses: number }[]) => rows.length > 0 ? rows.reduce((s, m) => s + m.expenses, 0) / rows.length : 0;

  // ── 2b. Shared context: one window of recent rows, data coverage, schedules ──
  // Every JS-side rule reads from this window instead of issuing its own query, and every row
  // in it already honours "exclude from insights".
  const recent = await db.select<RecentRow[]>(
    `SELECT t.id, t.account_id, a.account_type, a.name as account_name, t.date, t.description, t.amount_cents, t.category_id
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND a.excluded_from_insights=0 AND a.account_type!='loan' AND t.date>=?
     ORDER BY t.date, t.id`,
    [profileId, addDaysIso(todayIso, -120)]
  );
  const [rangeRow] = await db.select<{ first: string | null; last: string | null }[]>(
    `SELECT MIN(t.date) as first, MAX(t.date) as last
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND a.excluded_from_insights=0 AND a.account_type!='loan'`,
    [profileId]
  );
  const earliestIso = rangeRow?.first ?? null;
  const coverageEnd = rangeRow?.last ?? null;
  const coverageIsFresh = (days: number) => !!coverageEnd && daysBetweenIso(coverageEnd, todayIso) <= days;
  /** Days of the current month the imported data actually covers. */
  const elapsedDays = !coverageEnd ? 0
    : coverageEnd >= thisEnd ? today.getDate()
    : coverageEnd >= thisStart ? Math.min(today.getDate(), Number(coverageEnd.slice(8, 10)))
    : 0;
  const daysLeft = daysInThisMonth - today.getDate();

  const freshnessRows = await db.select<{
    id: number; name: string; account_type: string; first_date: string; last_date: string; n: number; manual_n: number;
  }[]>(
    `SELECT a.id, a.name, a.account_type, MIN(t.date) as first_date, MAX(t.date) as last_date, COUNT(*) as n,
            SUM(CASE WHEN t.import_hash LIKE 'manual_%' THEN 1 ELSE 0 END) as manual_n
     FROM accounts a JOIN transactions t ON t.account_id=a.id
     WHERE a.profile_id=? AND a.excluded_from_insights=0 AND a.hidden_from_dashboard=0
     GROUP BY a.id`,
    [profileId]
  );
  const coverageByAccount = new Map(freshnessRows.map((r) => [r.id, r.last_date]));

  const detectedCharges = await detectRecurringCharges([profileId]);
  const planned = await getPlannedRules(profileId, detectedCharges);
  const scenario = loadScenario(profileId);
  const rulesForEvents = scenario.detected ? [...planned.rules, ...planned.detected] : planned.rules;
  const plannedEvents14 = expandOccurrences(rulesForEvents, new Date(`${todayIso}T00:00:00`), new Date(`${addDaysIso(todayIso, 14)}T00:00:00`));
  const billRules: ScheduledLike[] = planned.activeRules.filter((r) => r.amount_cents < 0).map((r) => ({ description: r.description, amount_cents: r.amount_cents }));
  const detectedLike: ScheduledLike[] = detectedCharges.map((c) => ({ description: c.description, amount_cents: c.amount_cents }));
  const recurringKeys = new Set([...detectedCharges, ...planned.activeRules].map((c) => merchantKey(c.description)));
  const shapeTxns: ShapeTxn[] = recent.map((r) => ({ date: r.date, amount_cents: r.amount_cents, description: r.description, account_type: r.account_type, category_id: r.category_id }));
  const thisMonthRows = recent.filter((r) => r.date >= thisStart && r.date < thisEnd);
  const expensesThisMonth = thisMonthRows.filter((r) => r.amount_cents < 0 && !isExcludedCategory(r.category_id));

  // ── 3. Existing budgets ─────────────────────────────────────────────────
  const budgets = await db.select<{
    category_id: number;
    category_name: string;
    amount_cents: number;
  }[]>(
    `SELECT b.category_id, c.name as category_name, b.amount_cents
     FROM budgets b JOIN categories c ON b.category_id=c.id
     WHERE b.profile_id=?`,
    [profileId]
  );
  const budgetCatIds = new Set(budgets.map((b) => b.category_id));

  // ── 4. Category averages over the last 6 complete months ────────────────
  // The partial current month is left out so a suggestion or a spike baseline is never
  // diluted by a month that has barely started.
  const catAvgs = await db.select<{
    category_id: number;
    category_name: string;
    category_color: string;
    avg_monthly: number;
    month_count: number;
  }[]>(
    `SELECT t.category_id,
            c.name as category_name, c.color as category_color,
            CAST(AVG(monthly_total) AS INTEGER) as avg_monthly,
            COUNT(*) as month_count
     FROM (
       SELECT tx.category_id, strftime('%Y-%m', tx.date) as month,
              ${categorySpendSql("tx", "ac")} as monthly_total
       FROM transactions tx JOIN accounts ac ON ac.id=tx.account_id
       WHERE tx.profile_id=? AND ac.excluded_from_insights=0
         AND (tx.category_id IS NULL OR tx.category_id NOT IN (20,29))
         AND tx.date >= ? AND tx.date < ?
       GROUP BY tx.category_id, month
     ) t
     JOIN categories c ON t.category_id=c.id
     WHERE c.id != 15
     GROUP BY t.category_id
     HAVING month_count >= 2`,
    [profileId, monthBounds(months12[6])[0], thisStart]
  );

  // ── 5. This month's category spend ──────────────────────────────────────
  const thisMonthCats = await db.select<{
    category_id: number;
    total: number;
  }[]>(
    `SELECT t.category_id, ${categorySpendSql()} as total
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND t.date>=? AND t.date<? AND a.excluded_from_insights=0
       AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
     GROUP BY t.category_id`,
    [profileId, thisStart, thisEnd]
  );
  const thisMonthCatMap = new Map(thisMonthCats.map((c) => [c.category_id, c.total]));

  // ── INSIGHT: budget_gap ──────────────────────────────────────────────────
  for (const cat of catAvgs) {
    if (cat.avg_monthly >= 5000 && !budgetCatIds.has(cat.category_id)) {
      const suggested = Math.round(cat.avg_monthly * 1.1);
      insights.push({
        id: `budget_gap_${cat.category_id}`,
        type: "budget_gap",
        title: `No budget for ${cat.category_name}`,
        description: `You average ${formatCents(cat.avg_monthly)} a month on ${cat.category_name} with no budget set.`,
        severity: "info",
        impactCents: cat.avg_monthly,
        period: "a month",
        actionLabel: `Set ${formatCents(suggested)} budget`,
        action: {
          type: "create_budget",
          payload: {
            category_id: cat.category_id,
            category_name: cat.category_name,
            amount_cents: suggested,
            period: "monthly",
          },
        },
        dismissKey: `budget_gap_${cat.category_id}`,
        richData: {
          avgMonthlyCents: cat.avg_monthly,
          potentialLabel: `A budget keeps ${cat.category_name} in view every month`,
        },
      });
    }
  }

  // ── INSIGHT: unusual_spike ───────────────────────────────────────────────
  for (const cat of catAvgs) {
    const thisMonthSpend = thisMonthCatMap.get(cat.category_id) ?? 0;
    if (thisMonthSpend > cat.avg_monthly * 2 && thisMonthSpend > 5000) {
      insights.push({
        id: `unusual_spike_${cat.category_id}`,
        type: "unusual_spike",
        title: `Unusual spike in ${cat.category_name}`,
        description: `${formatCents(thisMonthSpend)} so far this month against an average of ${formatCents(cat.avg_monthly)} a month, ${Math.round((thisMonthSpend / cat.avg_monthly) * 100)}% of normal.`,
        severity: "warning",
        impactCents: thisMonthSpend - cat.avg_monthly,
        period: "this month",
        action: { type: "view_transactions", payload: { month: thisMonth, category: cat.category_id } },
        dismissKey: `unusual_spike_${cat.category_id}_${thisMonth}`,
      });
    }
  }

  // ── INSIGHT: savings_rate_low ────────────────────────────────────────────
  if (monthCount >= 2) {
    // The current month is only partly elapsed, so its income/expense totals aren't comparable
    // to a full month - blending it in makes the headline rate swing daily and disagree with
    // the savings-rate chart, which plots whole months.
    const recentSummaries = completeMonths.slice(0, 3);
    const lowSavingsMonths = recentSummaries.filter((s) => {
      if (s.income === 0) return false;
      return (s.income - s.expenses) / s.income < 0.2;
    });
    if (recentSummaries.length >= 2 && lowSavingsMonths.length >= 2) {
      const totalIncome = recentSummaries.reduce((s, r) => s + r.income, 0);
      const totalExpenses = recentSummaries.reduce((s, r) => s + r.expenses, 0);
      // Ratio of sums, not the mean of each month's own ratio: averaging ratios lets a single
      // low-income month (a small denominator) swing the result far past anything the
      // underlying dollars justify. Matches how `getSpendingProfile` computes the same figure.
      const avgRate = aggregateSavingsRate(recentSummaries) ?? 0;
      const avgIncome = totalIncome / recentSummaries.length;
      const suggestedSavings = Math.round(avgIncome * 0.2);
      const avgExpenses = totalExpenses / recentSummaries.length;
      const cutPct = avgExpenses > avgIncome * 0.8
        ? Math.round(((avgExpenses - avgIncome * 0.8) / avgExpenses) * 100) : 0;
      const savingsRatePct = Math.round(avgRate * 100);
      const savingsRateMemKey = `savings_rate_low_${profileId}`;
      const savingsRateRemembered = getRemembered(profileId, savingsRateMemKey);
      const savingsRateDescription = composeInsightText({
        type: "savings_rate_low",
        currentValue: savingsRatePct,
        currentLabel: `${savingsRatePct}%`,
        previousValue: savingsRateRemembered?.rawValue ?? null,
        previousLabel: savingsRateRemembered?.label ?? null,
        higherIsBetter: true,
        variantSeed: `${profileId}:savings_rate_low:${thisMonth}`,
        fallback: `Your recent savings rate is ${savingsRatePct}%. A savings goal could help you stay on track.`,
      });
      remember(profileId, savingsRateMemKey, savingsRatePct, `${savingsRatePct}%`, thisStart);
      insights.push({
        id: "savings_rate_low",
        type: "savings_rate_low",
        title: "Savings rate below 20%",
        description: savingsRateDescription,
        severity: "warning",
        impactCents: Math.max(0, Math.round(avgIncome * 0.2 - avgIncome * avgRate)),
        period: "a month",
        actionLabel: `Set ${formatCents(suggestedSavings)}/mo savings goal`,
        action: {
          type: "create_goal",
          payload: {
            name: "Monthly savings",
            type: "net_savings",
            target_cents: suggestedSavings,
          },
        },
        dismissKey: "savings_rate_low",
        richData: {
          currentRate: avgRate,
          targetRate: 0.2,
          rateLabel: `${recentSummaries.length}-month average`,
          potentialLabel: cutPct > 0
            ? `Cutting expenses by ${cutPct}% brings the savings rate to 20%`
            : undefined,
          potentialValue: cutPct > 0 ? cutPct : undefined,
        },
      });
    }
  }

  // ── INSIGHT: overspend_streak ────────────────────────────────────────────
  const budgetHistory: { category_id: number; category_name: string; over_count: number; under_count: number; budget_cents: number }[] = [];
  if (monthCount >= 2) {
    const definitions = await db.select<BudgetDefinition[]>(
      `SELECT b.*,c.name as category_name,c.parent_id as category_parent_id FROM budgets b JOIN categories c ON c.id=b.category_id
       WHERE b.profile_id=? AND b.is_global=0 AND b.period='monthly' AND c.id!=1 AND (c.parent_id IS NULL OR c.parent_id!=1)`, [profileId]);
    for (const budget of definitions) {
      const periods = [];
      const cursor = new Date();
      cursor.setDate(1);
      for (let offset = 0; offset < 12; offset++) {
        cursor.setMonth(cursor.getMonth() - 1);
        const month = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
        const [start, end] = monthBounds(month);
        if (start < budget.start_date) break;
        periods.push(await evaluateBudgetPeriod(db, budget, [profileId], start, end, true));
      }
      budgetHistory.push({ category_id: budget.category_id, category_name: budget.category_name, budget_cents: budget.amount_cents,
        over_count: periods.filter((period) => period.covered && !period.onTrack).length,
        under_count: periods.filter((period) => period.covered && period.onTrack).length });
    }
  }
  if (monthCount >= 2) {
    const budgetStreaks = budgetHistory.filter((budget) => budget.over_count >= 2);
    for (const row of budgetStreaks) {
      const overspendMemKey = `overspend_streak_${profileId}_${row.category_id}`;
      const overspendLabel = `${row.over_count} month${row.over_count !== 1 ? "s" : ""}`;
      const overspendDescription = `Over the effective limit in ${row.over_count} covered, completed months within the last year. Includes only accounts enabled for insights.`;
      remember(profileId, overspendMemKey, row.over_count, overspendLabel, thisStart);
      insights.push({
        id: `overspend_streak_${row.category_id}`,
        type: "overspend_streak",
        title: `Review the limit: ${row.category_name}`,
        description: overspendDescription,
        severity: "warning",
        impactCents: row.budget_cents,
        period: "a month",
        action: { type: "open_budgets", payload: {} },
        dismissKey: `overspend_streak_${row.category_id}`,
        richData: {
          budgetAmountCents: row.budget_cents,
          overCount: row.over_count,
          potentialLabel: `Staying under keeps the ${formatCents(row.budget_cents)} a month limit on track`,
        },
      });
    }
  }

  // ── INSIGHT: positive_streak ─────────────────────────────────────────────
  if (monthCount >= 3) {
    const underBudgetBudgets = budgetHistory.filter((budget) => budget.under_count >= 3);
    for (const row of underBudgetBudgets) {
      const streakMemKey = `positive_streak_${profileId}_${row.category_id}`;
      const streakLabel = `${row.under_count} month${row.under_count !== 1 ? "s" : ""}`;
      const streakDescription = `Within the effective limit in ${row.under_count} covered, completed months within the last year. Includes only accounts enabled for insights; these months need not be consecutive.`;
      remember(profileId, streakMemKey, row.under_count, streakLabel, thisStart);
      insights.push({
        id: `positive_streak_${row.category_id}`,
        type: "positive_streak",
        title: `Within budget: ${row.category_name}`,
        description: streakDescription,
        severity: "success",
        dismissKey: `positive_streak_${row.category_id}`,
        richData: {
          streakMonths: row.under_count,
          budgetAmountCents: row.budget_cents,
          potentialLabel: "Covered months, not a consecutive streak",
        },
      });
    }
  }

  // ── INSIGHT: budget_pace ─────────────────────────────────────────────────
  // This month's budgets: already over, or on pace to go over when the data is current.
  if (elapsedDays >= 5 && coverageIsFresh(10)) {
    const liveBudgets = await db.select<BudgetDefinition[]>(
      `SELECT b.*,c.name as category_name,c.parent_id as category_parent_id FROM budgets b JOIN categories c ON c.id=b.category_id
       WHERE ((b.profile_id=? AND b.is_global=0) OR b.is_global=1) AND b.period='monthly' AND c.id!=1 AND (c.parent_id IS NULL OR c.parent_id!=1)`,
      [profileId]
    );
    for (const budget of liveBudgets) {
      const period = await evaluateBudgetPeriod(db, budget, [profileId], thisStart, thisEnd, true);
      if (!period.covered || period.available <= 0) continue;
      const over = period.net - period.available;
      if (over >= Math.max(500, period.available * 0.05)) {
        insights.push({
          id: `budget_pace_${budget.id}_${thisMonth}`,
          type: "budget_pace",
          title: `${budget.category_name} is ${formatCents(over)} over its ${formatCents(period.available)} budget`,
          description: `Spent ${formatCurrency(period.net)} against ${formatCurrency(period.available)} with ${plural(daysLeft, "day", "days")} left in ${monthName(thisMonth)}.`,
          severity: "warning",
          impactCents: over,
          period: "this month",
          action: { type: "view_transactions", payload: { month: thisMonth, category: budget.category_id } },
          dismissKey: `budget_pace_${budget.id}_${thisMonth}`,
        });
      } else if (elapsedDays >= 10 && coverageIsFresh(3)) {
        const paced = Math.round((period.net / elapsedDays) * daysInThisMonth);
        if (paced > period.available * 1.15) {
          insights.push({
            id: `budget_pace_${budget.id}_${thisMonth}`,
            type: "budget_pace",
            title: `${budget.category_name} is on pace for ${formatCents(paced)} against a ${formatCents(period.available)} budget`,
            description: `${formatCurrency(period.net)} spent in ${plural(elapsedDays, "day", "days")}. Holding to ${formatCents(Math.max(0, Math.round((period.available - period.net) / Math.max(1, daysLeft))))} a day finishes inside the limit.`,
            severity: "info",
            impactCents: paced - period.available,
            period: "this month",
            action: { type: "view_transactions", payload: { month: thisMonth, category: budget.category_id } },
            dismissKey: `budget_pace_${budget.id}_${thisMonth}`,
          });
        }
      }
    }
  }

  // ── INSIGHT: recurring_price_change / new_recurring_charge ──────────────
  for (const charge of detectedCharges) {
    const change = detectPriceChange(charge.amountHistory);
    if (change) {
      const up = change.deltaCents > 0;
      const yearly = Math.abs(change.deltaCents) * 12;
      const id = `recurring_price_change_${chargeKey(charge.description)}_${change.currentCents}`;
      insights.push({
        id,
        type: "recurring_price_change",
        title: `${truncate(charge.description, 30)} went ${up ? "up" : "down"} ${formatCurrency(Math.abs(change.deltaCents))} a month`,
        description: `It was ${formatCurrency(change.previousCents)} and is now ${formatCurrency(change.currentCents)} as of ${shortDate(charge.last_seen)}, about ${formatCents(yearly)} ${up ? "more" : "less"} a year.`,
        severity: up && (change.pct >= 0.2 || change.deltaCents >= 1000) ? "warning" : "info",
        impactCents: yearly,
        period: "a year",
        action: { type: "view_transactions", payload: { search: charge.description, range: { start: addDaysIso(todayIso, -120), end: todayIso } } },
        dismissKey: id,
        richData: { previousAmountCents: change.previousCents, newAmountCents: change.currentCents },
      });
    }
    if (earliestIso && isNewRecurring(charge, earliestIso, todayIso)) {
      const monthly = Math.abs(charge.amount_cents);
      insights.push({
        id: `new_recurring_${chargeKey(charge.description)}`,
        type: "new_recurring_charge",
        title: `New recurring charge: ${truncate(charge.description, 30)}, ${formatCurrency(monthly)} a month`,
        description: `First seen ${shortDate(charge.first_seen)}, ${plural(charge.month_count, "month", "months")} running on the ${charge.patternLabel}. About ${formatCents(monthly * 12)} a year if it continues.`,
        severity: "info",
        impactCents: monthly * 12,
        period: "a year",
        action: { type: "view_transactions", payload: { search: charge.description, range: { start: addDaysIso(todayIso, -120), end: todayIso } } },
        dismissKey: `new_recurring_${chargeKey(charge.description)}`,
      });
    }
  }

  // ── INSIGHT: frequent_merchant ───────────────────────────────────────────
  {
    const since30 = addDaysIso(todayIso, -30);
    const rows30 = recent.filter((r) => r.date >= since30 && r.amount_cents < 0 && !isExcludedCategory(r.category_id));
    for (const m of findFrequentMerchants(rows30).filter((m) => !recurringKeys.has(m.key)).slice(0, 2)) {
      insights.push({
        id: `frequent_${m.key}_${thisMonth}`,
        type: "frequent_merchant",
        title: `${truncate(m.description, 25)} ${m.count} times in 30 days, ${formatCents(m.totalCents)}`,
        description: `About ${formatCents(m.totalCents)} a month at this pace, ${formatCurrency(Math.round(m.totalCents / m.count))} a visit. Worth a look if it is not deliberate.`,
        severity: "info",
        impactCents: m.totalCents,
        period: "30 days",
        action: { type: "view_transactions", payload: { search: m.description, range: { start: since30, end: todayIso } } },
        dismissKey: `frequent_${m.key}_${thisMonth}`,
      });
    }
  }

  // ── INSIGHT: income_irregular ────────────────────────────────────────────
  if (completeMonths.length >= 3) {
    const incomeMonths = completeMonths.slice(0, 3).filter((m) => m.income > 0);
    if (incomeMonths.length >= 3) {
      const avg = incomeMonths.reduce((s, m) => s + m.income, 0) / incomeMonths.length;
      const maxDev = Math.max(...incomeMonths.map((m) => Math.abs(m.income - avg) / avg));
      if (maxDev > 0.4) {
        // A two-paycheck month next to a three-paycheck month is not irregular income, it is a
        // biweekly calendar. Compare income per deposit before calling it irregular.
        const depositRows = await db.select<{ month: string; n: number }[]>(
          `SELECT strftime('%Y-%m', t.date) as month, COUNT(*) as n
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id=? AND a.excluded_from_insights=0 AND a.account_type NOT IN ('credit','loan')
             AND t.amount_cents>50000 AND t.category_id=1 AND t.date>=? AND t.date<?
           GROUP BY month`,
          [profileId, monthBounds(incomeMonths[incomeMonths.length - 1].month)[0], thisStart]
        );
        const perDeposit = incomeMonths.map((m) => {
          const n = depositRows.find((d) => d.month === m.month)?.n ?? 0;
          return n > 0 ? m.income / n : null;
        });
        const steadyPerDeposit = perDeposit.every((v) => v !== null) && (() => {
          const values = perDeposit as number[];
          const mean = values.reduce((s, v) => s + v, 0) / values.length;
          return values.every((v) => Math.abs(v - mean) / mean <= 0.25);
        })();
        if (!steadyPerDeposit) {
          insights.push({
            id: "income_irregular",
            type: "income_irregular",
            title: "Irregular income detected",
            description: `Your income has varied by up to ${Math.round(maxDev * 100)}% from month to month over the last three complete months. Building a buffer helps smooth that out.`,
            severity: "info",
            impactCents: Math.round(maxDev * avg),
            period: "a month",
            dismissKey: "income_irregular",
          });
        }
      }
    }
  }

  // ── INSIGHT: emergency_fund_runway (also covers a very low balance) ─────
  if (balanceKnown) {
    const balance = balanceRow.balance_cents;
    const balanceDate = balanceRow.date!;
    const expenseMonths = completeMonths.slice(0, 3).filter((m) => m.expenses > 0);
    const avgExp = expenseMonths.length > 0
      ? avgOf(expenseMonths)
      : currentSummary && elapsedDays >= 10 ? (currentSummary.expenses / elapsedDays) * daysInThisMonth : 0;
    const basis = expenseMonths.length > 0
      ? `average spending ${formatCents(avgExp)} a month over ${plural(expenseMonths.length, "complete month", "complete months")}`
      : `spending paced from this month so far, about ${formatCents(avgExp)} a month`;
    const runway = avgExp > 0 ? balance / avgExp : null;
    const runwayStr = runway === null ? null
      : runway < 1 ? "less than a month"
      : runway < 6 ? `about ${runway.toFixed(1)} months`
      : `${Math.floor(runway)} months`;

    if (balance >= 0 && balance < 50000) {
      insights.push({
        id: `low_balance_${balanceDate}`,
        type: "emergency_fund_runway",
        title: `Checking balance is ${formatCents(balance)}, under $500`,
        description: `As of ${formatDate(balanceDate)}.${runwayStr ? ` At ${basis}, this covers ${runwayStr} of expenses.` : ""}`,
        severity: "warning",
        impactCents: 50000 - balance,
        period: "today",
        dismissKey: `low_balance_${balanceDate}`,
        richData: runway !== null ? { runwayMonths: parseFloat(runway.toFixed(1)) } : undefined,
      });
    } else if (balance > 0 && runway !== null && runwayStr) {
      const gapToThree = Math.max(0, Math.round(avgExp * 3 - balance));
      insights.push({
        id: `emergency_fund_runway_${runway >= 6 ? quarterKey(today) : balanceDate}`,
        type: "emergency_fund_runway",
        title: `Your balance covers ${runwayStr} of expenses`,
        description: `Balance ${formatCents(balance)} as of ${formatDate(balanceDate)}, ${basis}.${runway < 3 ? " Three to six months is the usual cushion." : runway >= 6 ? " A healthy cushion." : ""}`,
        severity: runway < 1 ? "warning" : runway < 6 ? "info" : "success",
        impactCents: runway < 3 ? gapToThree : 0,
        period: "to reach 3 months",
        dismissKey: `emergency_fund_runway_${runway >= 6 ? quarterKey(today) : balanceDate}`,
        richData: {
          runwayMonths: parseFloat(runway.toFixed(1)),
          potentialLabel: runway < 3 ? `Saving ${formatCents(gapToThree)} more reaches a 3-month cushion` : undefined,
        },
      });
    }
  }

  // ── Credit cards: debt tracking, payment coverage, interest ─────────────
  // Generated per-account (not aggregated/latest-across-all-cards) so a profile with several
  // credit cards gets one accurate insight set per card instead of one ambiguous snapshot that
  // happens to belong to whichever card was most recently imported - AccountDetailModal relies
  // on `accountId` here to show each card only its own insights.
  const creditAccounts = await db.select<{ id: number; name: string; interest_rate_bps: number | null; minimum_payment_cents: number | null }[]>(
    `SELECT id, name, interest_rate_bps, minimum_payment_cents FROM accounts WHERE profile_id=? AND account_type='credit' AND excluded_from_insights=0`,
    [profileId]
  );
  /** Charges, payments and stray credits on one card in one complete month, from the shared window. */
  const cardMonth = (accountId: number, month: string) => {
    const [start, end] = monthBounds(month);
    let purchases = 0, payments = 0, stray = 0;
    for (const r of recent) {
      if (r.account_id !== accountId || r.date < start || r.date >= end) continue;
      if (r.amount_cents < 0 && !isExcludedCategory(r.category_id)) purchases += -r.amount_cents;
      else if (r.amount_cents > 0 && r.category_id === 20) payments += r.amount_cents;
      else if (r.amount_cents > 0 && r.category_id !== 29) stray++;
    }
    return { purchases, payments, stray };
  };
  for (const acct of creditAccounts) {
    const [creditBalanceRow] = await db.select<{ balance_cents: number; date: string }[]>(
      `SELECT balance_cents, date FROM transactions
       WHERE account_id=? AND balance_cents IS NOT NULL
       ORDER BY date DESC, id DESC LIMIT 1`,
      [acct.id]
    );
    const m0 = completeMonths[0]?.month;
    const m1 = completeMonths[1]?.month;
    const coverage0 = m0 ? cardMonth(acct.id, m0) : null;
    const coverage1 = m1 ? cardMonth(acct.id, m1) : null;
    const coverageSentence = m0 && coverage0 && coverage0.purchases > 0
      ? ` You paid ${formatCents(coverage0.payments)} against ${formatCents(coverage0.purchases)} charged in ${monthName(m0)}.`
      : "";

    if (m0 && m1 && coverage0 && coverage1
      && coverage0.purchases >= 5000 && coverage1.purchases >= 5000
      && coverage0.payments >= coverage0.purchases && coverage1.payments >= coverage1.purchases) {
      insights.push({
        id: `card_paid_in_full_${acct.id}_${quarterKey(today)}`,
        type: "card_paid_in_full",
        title: `You paid ${acct.name} in full for ${monthName(m1)} and ${monthName(m0)}`,
        description: "Payments matched or beat new charges in both months, so this card is not costing interest.",
        severity: "success",
        dismissKey: `card_paid_in_full_${acct.id}_${quarterKey(today)}`,
        accountId: acct.id,
      });
    }

    // Interest actually charged on the card, from the statement lines themselves.
    const interestMonth = m0 ?? thisMonth;
    const [iStart, iEnd] = monthBounds(interestMonth);
    const interestCents = recent
      .filter((r) => r.account_id === acct.id && r.amount_cents < 0 && !isExcludedCategory(r.category_id)
        && r.date >= iStart && r.date < iEnd && INTEREST_RE.test(r.description) && !NOT_INTEREST_RE.test(r.description))
      .reduce((s, r) => s - r.amount_cents, 0);
    if (interestCents > 0) {
      insights.push({
        id: `interest_paid_${acct.id}_${interestMonth}`,
        type: "interest_paid",
        title: `${formatCents(interestCents)} of interest on ${acct.name} in ${monthName(interestMonth)}`,
        description: `At this rate the card costs about ${formatCents(interestCents * 12)} a year in interest. Paying the statement balance in full stops it.`,
        severity: interestCents >= 5000 ? "warning" : "info",
        impactCents: interestCents * 12,
        period: "a year",
        action: { type: "open_payoff", payload: {} },
        dismissKey: `interest_paid_${acct.id}_${interestMonth}`,
        accountId: acct.id,
      });
    }

    if (creditBalanceRow?.balance_cents == null) {
      // No statement balance on file: payment coverage is the only view of whether the card is
      // being carried. Skip when positive rows exist outside Transfers (payments probably
      // miscategorized), since the ratio would be wrong.
      if (m0 && m1 && coverage0 && coverage1 && coverage0.stray === 0 && coverage1.stray === 0
        && coverage0.purchases >= 20000 && coverage1.purchases >= 20000
        && coverage0.payments < coverage0.purchases * 0.9 && coverage1.payments < coverage1.purchases * 0.9) {
        const avgPurchases = Math.round((coverage0.purchases + coverage1.purchases) / 2);
        const avgPayments = Math.round((coverage0.payments + coverage1.payments) / 2);
        insights.push({
          id: `card_coverage_${acct.id}_${m0}`,
          type: "card_coverage_low",
          title: `Payments covered ${Math.round((avgPayments / avgPurchases) * 100)}% of new charges on ${acct.name}`,
          description: `Over ${monthName(m1)} and ${monthName(m0)} you charged about ${formatCents(avgPurchases)} a month and paid ${formatCents(avgPayments)}. About ${formatCents(avgPurchases - avgPayments)} a month is being carried.`,
          severity: "warning",
          impactCents: avgPurchases - avgPayments,
          period: "a month",
          action: { type: "open_payoff", payload: {} },
          dismissKey: `card_coverage_${acct.id}_${m0}`,
          accountId: acct.id,
          richData: { shareBar: { segments: [
            { label: "Paid", cents: avgPayments, kind: "left" },
            { label: "Carried", cents: avgPurchases - avgPayments, kind: "unknown" },
          ] } },
        });
      }
      continue;
    }

    const [creditBalancePriorRow] = await db.select<{ balance_cents: number }[]>(
      `SELECT balance_cents FROM transactions
       WHERE account_id=? AND balance_cents IS NOT NULL AND date < ?
       ORDER BY date DESC, id DESC LIMIT 1`,
      [acct.id, thisStart]
    );
    const debt = creditBalanceRow.balance_cents; // negative = amount owed
    const creditRichData = {
      accountType: "credit" as const,
      accountBalanceCents: debt,
      accountInterestRateBps: acct.interest_rate_bps,
      accountMinimumPaymentCents: acct.minimum_payment_cents,
    };
    if (debt < -100000) {
      // Carrying more than $1,000 in credit card debt
      insights.push({
        id: `credit_card_debt_high_${acct.id}_${creditBalanceRow.date}`,
        type: "credit_card_debt_high",
        title: `${acct.name}: ${formatCents(Math.abs(debt))} owed`,
        description: `You are carrying a balance of ${formatCents(Math.abs(debt))} on ${acct.name} as of ${formatDate(creditBalanceRow.date)}. Interest adds up quickly, and paying down a high-rate card usually beats what a savings account returns.${coverageSentence}`,
        severity: "warning",
        impactCents: Math.abs(debt),
        period: "owed",
        action: { type: "open_payoff", payload: {} },
        dismissKey: `credit_card_debt_high_${acct.id}_${creditBalanceRow.date}`,
        accountId: acct.id,
        richData: creditRichData,
      });
    }
    if (creditBalancePriorRow?.balance_cents != null) {
      const delta = debt - creditBalancePriorRow.balance_cents; // negative = debt grew
      if (delta < -5000) {
        insights.push({
          id: `credit_card_debt_growing_${acct.id}_${thisMonth}`,
          type: "credit_card_debt_growing",
          title: `${acct.name} debt grew by ${formatCents(Math.abs(delta))}`,
          description: composeInsightText({
            type: "credit_card_debt_growing",
            currentValue: Math.abs(debt),
            currentLabel: formatCents(Math.abs(debt)),
            previousValue: Math.abs(creditBalancePriorRow.balance_cents),
            previousLabel: formatCents(Math.abs(creditBalancePriorRow.balance_cents)),
            higherIsBetter: false,
            variantSeed: `${profileId}:credit_card_debt_growing:${acct.id}:${thisMonth}`,
            fallback: `${acct.name}'s balance went from ${formatCents(Math.abs(creditBalancePriorRow.balance_cents))} to ${formatCents(Math.abs(debt))} owed. Keep an eye on this before it compounds with interest.`,
          }) + coverageSentence,
          severity: "warning",
          impactCents: Math.abs(delta),
          period: "this month",
          action: { type: "open_payoff", payload: {} },
          dismissKey: `credit_card_debt_growing_${acct.id}_${thisMonth}`,
          accountId: acct.id,
          richData: creditRichData,
        });
      } else if (delta > 5000) {
        insights.push({
          id: `credit_card_debt_improving_${acct.id}_${thisMonth}`,
          type: "credit_card_debt_improving",
          title: `Paid down ${formatCents(delta)} on ${acct.name}`,
          description: composeInsightText({
            type: "credit_card_debt_improving",
            currentValue: Math.abs(debt),
            currentLabel: formatCents(Math.abs(debt)),
            previousValue: Math.abs(creditBalancePriorRow.balance_cents),
            previousLabel: formatCents(Math.abs(creditBalancePriorRow.balance_cents)),
            higherIsBetter: false,
            variantSeed: `${profileId}:credit_card_debt_improving:${acct.id}:${thisMonth}`,
            fallback: `Nice progress: ${acct.name}'s balance improved from ${formatCents(Math.abs(creditBalancePriorRow.balance_cents))} to ${formatCents(Math.abs(debt))} owed.`,
          }) + coverageSentence,
          severity: "success",
          impactCents: delta,
          period: "this month",
          dismissKey: `credit_card_debt_improving_${acct.id}_${thisMonth}`,
          accountId: acct.id,
          richData: creditRichData,
        });
      }
    }
  }

  // ── INSIGHT: loan debt (mirrors the credit-card debt block above, but loans are
  //   naturally much larger - $5,000 threshold instead of credit's $1,000) ─────────
  const loanAccountsForDebt = await db.select<{ id: number; name: string; interest_rate_bps: number | null; minimum_payment_cents: number | null }[]>(
    `SELECT id, name, interest_rate_bps, minimum_payment_cents FROM accounts WHERE profile_id=? AND account_type='loan' AND excluded_from_insights=0`,
    [profileId]
  );
  for (const acct of loanAccountsForDebt) {
    const [loanBalanceRow] = await db.select<{ balance_cents: number; date: string }[]>(
      `SELECT balance_cents, date FROM transactions
       WHERE account_id=? AND balance_cents IS NOT NULL
       ORDER BY date DESC, id DESC LIMIT 1`,
      [acct.id]
    );
    if (loanBalanceRow?.balance_cents == null) continue;
    const [loanBalancePriorRow] = await db.select<{ balance_cents: number }[]>(
      `SELECT balance_cents FROM transactions
       WHERE account_id=? AND balance_cents IS NOT NULL AND date < ?
       ORDER BY date DESC, id DESC LIMIT 1`,
      [acct.id, thisStart]
    );
    const loanDebt = loanBalanceRow.balance_cents; // negative = amount owed
    const loanRichData = {
      accountType: "loan" as const,
      accountBalanceCents: loanDebt,
      accountInterestRateBps: acct.interest_rate_bps,
      accountMinimumPaymentCents: acct.minimum_payment_cents,
    };
    if (loanDebt < -500000) {
      // Carrying more than $5,000 on this loan
      insights.push({
        id: `loan_debt_high_${acct.id}_${loanBalanceRow.date}`,
        type: "loan_debt_high",
        title: `${acct.name}: ${formatCents(Math.abs(loanDebt))} owed`,
        description: `You are carrying a balance of ${formatCents(Math.abs(loanDebt))} on ${acct.name} as of ${formatDate(loanBalanceRow.date)}.`,
        severity: "info",
        impactCents: Math.abs(loanDebt),
        period: "owed",
        dismissKey: `loan_debt_high_${acct.id}_${loanBalanceRow.date}`,
        accountId: acct.id,
        richData: loanRichData,
      });
    }
    if (loanBalancePriorRow?.balance_cents != null) {
      const loanDelta = loanDebt - loanBalancePriorRow.balance_cents; // negative = debt grew
      if (loanDelta < -5000) {
        insights.push({
          id: `loan_debt_growing_${acct.id}_${thisMonth}`,
          type: "loan_debt_growing",
          title: `${acct.name} balance grew by ${formatCents(Math.abs(loanDelta))}`,
          description: composeInsightText({
            type: "loan_debt_growing",
            currentValue: Math.abs(loanDebt),
            currentLabel: formatCents(Math.abs(loanDebt)),
            previousValue: Math.abs(loanBalancePriorRow.balance_cents),
            previousLabel: formatCents(Math.abs(loanBalancePriorRow.balance_cents)),
            higherIsBetter: false,
            variantSeed: `${profileId}:loan_debt_growing:${acct.id}:${thisMonth}`,
            fallback: `${acct.name}'s balance went from ${formatCents(Math.abs(loanBalancePriorRow.balance_cents))} to ${formatCents(Math.abs(loanDebt))} owed this month.`,
          }),
          severity: "warning",
          impactCents: Math.abs(loanDelta),
          period: "this month",
          dismissKey: `loan_debt_growing_${acct.id}_${thisMonth}`,
          accountId: acct.id,
          richData: loanRichData,
        });
      } else if (loanDelta > 5000) {
        insights.push({
          id: `loan_debt_improving_${acct.id}_${thisMonth}`,
          type: "loan_debt_improving",
          title: `Paid down ${formatCents(loanDelta)} on ${acct.name}`,
          description: composeInsightText({
            type: "loan_debt_improving",
            currentValue: Math.abs(loanDebt),
            currentLabel: formatCents(Math.abs(loanDebt)),
            previousValue: Math.abs(loanBalancePriorRow.balance_cents),
            previousLabel: formatCents(Math.abs(loanBalancePriorRow.balance_cents)),
            higherIsBetter: false,
            variantSeed: `${profileId}:loan_debt_improving:${acct.id}:${thisMonth}`,
            fallback: `Nice progress: ${acct.name}'s balance improved from ${formatCents(Math.abs(loanBalancePriorRow.balance_cents))} to ${formatCents(Math.abs(loanDebt))} owed.`,
          }),
          severity: "success",
          impactCents: loanDelta,
          period: "this month",
          dismissKey: `loan_debt_improving_${acct.id}_${thisMonth}`,
          accountId: acct.id,
          richData: loanRichData,
        });
      }
    }
  }

  // ── INSIGHT: loan_payoff_projection + debt_payoff_priority ────────────────
  // Reuses the richer LoanAccount shape (interest_rate_bps, minimum_payment_cents) rather
  // than re-querying balances - this is the same data already fetched for the Debt
  // Dashboard, so both interest_rate_bps and minimum_payment_cents come "for free".
  const [loanListForPayoff, creditListForPayoff] = await Promise.all([
    getLoanAccountsForProfile(profileId),
    getCreditAccountsForProfile(profileId),
  ]);
  const debts = [
    ...loanListForPayoff.map((d) => ({ ...d, kind: "loan" as const })),
    ...creditListForPayoff.map((d) => ({ ...d, kind: "credit" as const })),
  ].filter((d) => (d.balance_cents ?? 0) < 0);

  for (const debt of debts) {
    if (debt.interest_rate_bps == null || debt.minimum_payment_cents == null) continue;
    const balanceDollars = Math.abs(debt.balance_cents ?? 0) / 100;
    const paymentDollars = debt.minimum_payment_cents / 100;
    const monthlyRate = debt.interest_rate_bps / 10000 / 12;
    const months = estimatePayoffMonths(balanceDollars, monthlyRate, paymentDollars);
    const aprLabel = `${(debt.interest_rate_bps / 100).toFixed(2)}%`;
    const payoffRichData = {
      accountType: debt.kind,
      accountBalanceCents: debt.balance_cents,
      accountInterestRateBps: debt.interest_rate_bps,
      accountMinimumPaymentCents: debt.minimum_payment_cents,
    };
    if (months == null) {
      insights.push({
        id: `loan_payoff_projection_${debt.id}`,
        type: "loan_payoff_projection",
        title: `${debt.name}: the minimum payment will not pay this off`,
        description: `At ${aprLabel} APR, your ${formatCents(debt.minimum_payment_cents)} a month payment on ${debt.name} does not cover the interest on ${formatCents(Math.abs(debt.balance_cents ?? 0))} owed. The balance grows if you only pay the minimum.`,
        severity: "warning",
        impactCents: Math.abs(debt.balance_cents ?? 0),
        period: "owed",
        action: { type: "open_payoff", payload: {} },
        dismissKey: `loan_payoff_projection_${debt.id}`,
        accountId: debt.id,
        richData: payoffRichData,
      });
    } else if (months > 1) {
      const years = months / 12;
      const totalInterestCents = Math.round((paymentDollars * months - balanceDollars) * 100);
      insights.push({
        id: `loan_payoff_projection_${debt.id}`,
        type: "loan_payoff_projection",
        title: `${debt.name}: about ${years < 1 ? `${Math.round(months)} months` : `${years.toFixed(1)} years`} to pay off`,
        description: `At your current ${formatCents(debt.minimum_payment_cents)} a month payment and ${aprLabel} APR, ${debt.name} is projected to cost about ${formatCents(totalInterestCents)} in interest before it is paid off.`,
        severity: "info",
        impactCents: totalInterestCents,
        period: "total interest",
        action: { type: "open_payoff", payload: {} },
        dismissKey: `loan_payoff_projection_${debt.id}`,
        accountId: debt.id,
        richData: payoffRichData,
      });
    }
  }

  const ratedDebts = debts.filter((d) => d.interest_rate_bps != null);
  if (ratedDebts.length >= 2) {
    const topPriority = [...ratedDebts].sort((a, b) => (b.interest_rate_bps ?? 0) - (a.interest_rate_bps ?? 0))[0];
    insights.push({
      id: `debt_payoff_priority_${thisMonth}`,
      type: "debt_payoff_priority",
      title: `Focus extra payments on ${topPriority.name}`,
      description: `${topPriority.name} carries the highest rate among your debts at ${(topPriority.interest_rate_bps! / 100).toFixed(2)}% APR, with ${formatCents(Math.abs(topPriority.balance_cents ?? 0))} owed. Paying this down first (the avalanche method) saves the most in interest over time.`,
      severity: "info",
      impactCents: Math.abs(topPriority.balance_cents ?? 0),
      period: "owed",
      action: { type: "open_payoff", payload: {} },
      dismissKey: `debt_payoff_priority_${thisMonth}`,
      accountId: topPriority.id,
      richData: {
        accountType: topPriority.kind,
        accountBalanceCents: topPriority.balance_cents,
        accountInterestRateBps: topPriority.interest_rate_bps,
        accountMinimumPaymentCents: topPriority.minimum_payment_cents,
      },
    });
  }

  // ── INSIGHT: top_merchants ───────────────────────────────────────────────
  {
    const groups = new Map<string, { description: string; total: number }>();
    let monthTotal = 0;
    for (const r of expensesThisMonth) {
      const key = merchantKey(r.description);
      if (!key) continue;
      monthTotal += -r.amount_cents;
      const g = groups.get(key) ?? { description: r.description, total: 0 };
      g.total += -r.amount_cents;
      groups.set(key, g);
    }
    const ranked = [...groups.values()].sort((a, b) => b.total - a.total);
    if (ranked.length >= 3 && monthTotal > 0) {
      const top3 = ranked.slice(0, 3);
      const top3Total = top3.reduce((s, m) => s + m.total, 0);
      insights.push({
        id: `top_merchants_${thisMonth}`,
        type: "top_merchants",
        title: "Top merchants this month",
        description: `${listClauses(top3.map((m) => `${truncate(m.description, 28)} ${formatCents(m.total)}`))}, ${Math.round((top3Total / monthTotal) * 100)}% of this month's spending.`,
        severity: "info",
        impactCents: top3Total,
        period: "this month",
        action: { type: "view_transactions", payload: { month: thisMonth } },
        dismissKey: `top_merchants_${thisMonth}`,
        richData: { items: ranked.slice(0, 5).map((m) => ({ label: m.description, valueCents: m.total })) },
      });
    }
  }

  // ── INSIGHT: food_delivery_spend ────────────────────────────────────────
  {
    const deliveryTotal = expensesThisMonth
      .filter((r) => /DOORDASH|UBER EATS|GRUBHUB|INSTACART/i.test(r.description))
      .reduce((s, r) => s - r.amount_cents, 0);
    // Sum food-related categories: Food & Dining(3), Groceries(13). ("Restaurants"
    // (14) was merged into Food & Dining in db.ts's v19 migration.)
    const totalFoodSpend = [3, 13].reduce((s, id) => s + (thisMonthCatMap.get(id) ?? 0), 0);
    if (deliveryTotal > 3000 && totalFoodSpend > 0) {
      const pct = Math.round((deliveryTotal / totalFoodSpend) * 100);
      insights.push({
        id: `food_delivery_${thisMonth}`,
        type: "food_delivery_spend",
        title: `${pct}% of food spending is delivery apps`,
        description: `Food delivery ${formatCents(deliveryTotal)} of ${formatCents(totalFoodSpend)} spent on food this month. Cooking more could save about ${formatCents(Math.round(deliveryTotal * 0.6))} a month.`,
        severity: pct > 50 ? "warning" : "info",
        impactCents: Math.round(deliveryTotal * 0.6),
        period: "a month",
        dismissKey: `food_delivery_${thisMonth}`,
      });
    }
  }

  // ── INSIGHT: subscription_total ─────────────────────────────────────────
  // Live recurring charges only (current amounts, active streaks), leaving out housing,
  // utilities, insurance and debt payments, which recur but are not subscriptions.
  {
    const notSubscription = new Set(["Housing", "Utilities", "Rent / Mortgage", "Insurance", "Debt", "Transfers"]);
    const subs = detectedCharges.filter((c) => Math.abs(c.amount_cents) <= 10000 && !notSubscription.has(c.category_name ?? ""));
    if (subs.length > 0) {
      const monthlyTotal = subs.reduce((s, c) => s + Math.abs(c.amount_cents), 0);
      const preview = subs.slice(0, 3).map((s) => `${truncate(s.description, 18)} ${formatCurrency(Math.abs(s.amount_cents))}`).join(", ");
      insights.push({
        id: `subscription_total_${thisMonth}`,
        type: "subscription_total",
        title: `${plural(subs.length, "recurring charge adds", "recurring charges add")} up to ${formatCents(monthlyTotal)} a month, ${formatCents(monthlyTotal * 12)} a year`,
        description: `${preview}${subs.length > 3 ? `, and ${subs.length - 3} more` : ""}.`,
        severity: "info",
        impactCents: monthlyTotal,
        period: "a month",
        action: { type: "open_section", payload: { section: "subs" } },
        dismissKey: `subscription_total_${thisMonth}`,
        richData: { items: subs.slice(0, 5).map((s) => ({ label: s.description, valueCents: Math.abs(s.amount_cents), color: s.category_color })) },
      });
    }
  }

  // ── INSIGHT: bills_this_week (scheduled truth first) ─────────────────────
  let shortfallWarned = false;
  const nextIncome = nextIncomeEvent(plannedEvents14, todayIso);
  {
    const bills7 = billsDueWithin(plannedEvents14, todayIso, 7);
    if (bills7.length > 0) {
      const total = bills7.reduce((s, e) => s - e.amountCents, 0);
      const timeline = bills7.map((e) => ({ date: e.date, label: e.description, cents: -e.amountCents, kind: e.source }));
      const freshBalance = balanceKnown && daysBetweenIso(balanceRow.date!, todayIso) <= 7;
      const projection = freshBalance
        ? projectCashFlow({ startingBalanceCents: balanceRow.balance_cents, startDate: todayIso, days: 15, events: plannedEvents14 })
        : null;
      const shortfall = projection?.firstShortfall ?? null;

      if (projection && shortfall) {
        const trigger = [...plannedEvents14]
          .filter((e) => e.amountCents < 0 && e.date <= shortfall.date)
          .sort((a, b) => a.amountCents - b.amountCents)[0] ?? bills7[0];
        const recoveryDay = projection.days.find((d) => d.date > shortfall.date && d.balanceCents >= 0);
        const recovery = recoveryDay ? plannedEvents14.find((e) => e.amountCents > 0 && e.date > shortfall.date && e.date <= recoveryDay.date) ?? null : null;
        const gap = Math.abs(projection.lowPoint?.balanceCents ?? shortfall.balanceCents);
        const triggerDays = daysBetweenIso(todayIso, trigger.date);
        insights.push({
          id: `shortfall_${shortfall.date}_${trigger.key}`,
          type: "bills_this_week",
          title: `Short ${formatCents(gap)} for ${truncate(trigger.description, 24)} ${describeDays(triggerDays)}`,
          description: `${trigger.description} of ${formatCents(Math.abs(trigger.amountCents))} is due ${describeDays(triggerDays)} and your checking balance is ${formatCents(balanceRow.balance_cents)}.`
            + (recovery ? ` ${recovery.description} of ${formatCents(recovery.amountCents)} on ${shortDate(recovery.date)} brings you back above zero.` : " No scheduled income lands in the next 14 days."),
          severity: "warning",
          impactCents: gap,
          period: "next 7 days",
          action: { type: "open_plan", payload: {} },
          dismissKey: `shortfall_${shortfall.date}_${trigger.key}`,
          richData: { timeline },
        });
        shortfallWarned = true;
      } else {
        const first = bills7[0];
        const firstDays = daysBetweenIso(todayIso, first.date);
        const incomeSentence = nextIncome && daysBetweenIso(todayIso, nextIncome.date) <= 7
          ? ` ${nextIncome.description} of ${formatCents(nextIncome.amountCents)} lands ${describeDays(daysBetweenIso(todayIso, nextIncome.date))}.`
          : "";
        insights.push({
          id: `bills_week_${addDaysIso(todayIso, -((today.getDay() + 6) % 7))}`,
          type: "bills_this_week",
          title: bills7.length === 1
            ? `${truncate(first.description, 30)} due ${describeDays(firstDays)}, ${formatCents(-first.amountCents)}`
            : `${plural(bills7.length, "bill", "bills")} due in the next 7 days, ${formatCents(total)} in total`,
          description: `${listClauses(bills7.slice(0, 3).map((e) => `${truncate(e.description, 24)} ${formatCents(-e.amountCents)} ${describeDays(daysBetweenIso(todayIso, e.date))}`))}${bills7.length > 3 ? ` and ${bills7.length - 3} more` : ""}.${incomeSentence}`,
          severity: "info",
          impactCents: total,
          period: "next 7 days",
          action: { type: "open_plan", payload: {} },
          dismissKey: `bills_week_${addDaysIso(todayIso, -((today.getDay() + 6) % 7))}`,
          richData: { timeline },
        });
      }
    }
  }

  // ── INSIGHT: income_expected ─────────────────────────────────────────────
  if (nextIncome && !shortfallWarned) {
    const days = daysBetweenIso(todayIso, nextIncome.date);
    insights.push({
      id: `income_expected_${nextIncome.date}`,
      type: "income_expected",
      title: `${truncate(nextIncome.description, 30)} of ${formatCents(nextIncome.amountCents)} expected ${describeDays(days)}`,
      description: `Scheduled in Plan for ${shortDate(nextIncome.date)}.`,
      severity: "info",
      impactCents: nextIncome.amountCents,
      period: days <= 7 ? "next 7 days" : "next 14 days",
      action: { type: "open_plan", payload: {} },
      dismissKey: `income_expected_${nextIncome.date}`,
    });
  } else if (!planned.hasIncomeRule && !shortfallWarned) {
    // No paycheck scheduled: infer the cycle from payroll deposits.
    const payrollTxns = await db.select<{ date: string; amount_cents: number }[]>(
      `SELECT t.date, t.amount_cents FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id=? AND a.excluded_from_insights=0 AND a.account_type NOT IN ('credit','loan')
         AND t.amount_cents>50000 AND t.category_id=1
       ORDER BY t.date DESC LIMIT 6`,
      [profileId]
    );
    if (payrollTxns.length >= 3) {
      const intervals: number[] = [];
      for (let i = 0; i < payrollTxns.length - 1; i++) {
        const days = daysBetweenIso(payrollTxns[i + 1].date, payrollTxns[i].date);
        if (days > 0 && days <= 35) intervals.push(days);
      }
      if (intervals.length >= 2) {
        const avgInterval = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
        const spread = Math.max(...intervals) - Math.min(...intervals);
        const nextPay = addDaysIso(payrollTxns[0].date, avgInterval);
        const daysUntil = daysBetweenIso(todayIso, nextPay);
        if (spread <= 3 && daysUntil >= 0 && daysUntil <= 14) {
          insights.push({
            id: `income_expected_${nextPay}`,
            type: "income_expected",
            title: daysUntil === 0 ? "Paycheck expected today" : `Paycheck expected ${describeDays(daysUntil)}`,
            description: `Based on your ${avgInterval}-day pay cycle. Last deposit ${formatCents(Math.abs(payrollTxns[0].amount_cents))} on ${formatDate(payrollTxns[0].date)}. Scheduling it in Plan makes this exact.`,
            severity: "info",
            impactCents: Math.abs(payrollTxns[0].amount_cents),
            period: daysUntil <= 7 ? "next 7 days" : "next 14 days",
            action: { type: "open_plan", payload: {} },
            dismissKey: `income_expected_${nextPay}`,
          });
        }
      }
    }
  }

  // ── INSIGHT: supplemental_income ───────────────────────────────────
  // Deposits beyond the Plan schedule. Planned income covers the bills; money that arrives on
  // top of it is easiest to direct somewhere deliberate before it blends into the month.
  if (planned.hasIncomeRule) {
    const incomeRules = planned.rules.filter((r) => r.amount_cents > 0);
    const supplemental = thisMonthRows.filter((r) =>
      isIncomeTxn({ date: r.date, amount_cents: r.amount_cents, description: r.description, account_type: r.account_type, category_id: r.category_id })
      && !incomeRules.some((rule) => chargeMatchesRule({ description: r.description, amount_cents: r.amount_cents }, rule)));
    const supplementalTotal = supplemental.reduce((s, r) => s + r.amount_cents, 0);
    if (supplementalTotal >= 10000) {
      const examples = [...supplemental]
        .sort((a, b) => b.amount_cents - a.amount_cents)
        .slice(0, 2)
        .map((r) => `${truncate(r.description, 26)} (${formatCents(r.amount_cents)})`);
      insights.push({
        id: `supplemental_income_${thisMonth}`,
        type: "supplemental_income",
        title: `${formatCents(supplementalTotal)} arrived beyond your planned income this month`,
        description: `${listClauses(examples)} landed outside your Plan schedule. Supplemental money is not spoken for by bills, so it is the easiest to put to work deliberately - ${debts.length > 0 ? "an extra debt payment locks it in before it dissolves into everyday spending" : "a goal contribution locks it in before it dissolves into everyday spending"}.`,
        severity: "success",
        impactCents: supplementalTotal,
        period: "this month",
        action: debts.length > 0 ? { type: "open_payoff", payload: {} } : { type: "open_goals", payload: {} },
        dismissKey: `supplemental_income_${thisMonth}`,
      });
    }
  }

  // ── INSIGHT: scheduled_missing ──────────────────────────────────────────
  if (coverageEnd) {
    const scheduledRules = planned.rules.map((r) => ({ ...r, accountId: planned.activeRules.find((a) => a.id === r.id)?.account_id ?? null }));
    const missing = findMissingScheduled(scheduledRules, recent, todayIso, coverageEnd, { coverageByAccount });
    for (const miss of missing.slice(0, 4)) {
      const amount = Math.abs(miss.rule.amount_cents);
      const isBill = miss.kind === "bill";
      const windowEnd = coverageEnd < addDaysIso(miss.expectedDate, 10) ? coverageEnd : addDaysIso(miss.expectedDate, 10);
      insights.push({
        id: `missing_${miss.rule.id}_${miss.expectedDate}`,
        type: "scheduled_missing",
        title: isBill
          ? `${truncate(miss.rule.description, 30)} scheduled for ${shortDate(miss.expectedDate)} has not posted`
          : `${truncate(miss.rule.description, 30)} expected ${shortDate(miss.expectedDate)} has not arrived`,
        description: `No ${isBill ? "charge" : "deposit"} matching ${miss.rule.description} (${formatCents(amount)}) between ${shortDate(addDaysIso(miss.expectedDate, -5))} and ${shortDate(windowEnd)}. If it was ${isBill ? "paid another way" : "received elsewhere"}, update the rule in Plan.`,
        severity: isBill ? "warning" : "info",
        impactCents: amount,
        period: shortDate(miss.expectedDate),
        action: { type: "open_plan", payload: {} },
        dismissKey: `missing_${miss.rule.id}_${miss.expectedDate}`,
        richData: { timeline: [{ date: miss.expectedDate, label: miss.rule.description, cents: amount, kind: "rule" }] },
      });
    }
  }

  // ── INSIGHT: duplicate_charge ────────────────────────────────────────────
  {
    const dupRows = recent.filter((r) => r.amount_cents < 0 && !isExcludedCategory(r.category_id));
    const skipIds = new Set(dupRows.filter((r) => DUPLICATE_SKIP_RE.test(r.description) || ((r.category_id === 3 || r.category_id === 13) && -r.amount_cents < 5000)).map((r) => r.id));
    const accountNames = new Map(recent.map((r) => [r.account_id, r.account_name]));
    const dups = findDuplicateCharges(dupRows, { sinceIso: addDaysIso(todayIso, -45), excludeKeys: recurringKeys, skip: (r) => skipIds.has(r.id) });
    for (const d of dups.slice(0, 3)) {
      const n = d.ids.length;
      insights.push({
        id: `dup_${d.key}_${d.date}_${d.amountCents}`,
        type: "duplicate_charge",
        title: `${n === 2 ? "Two" : n} identical charges from ${truncate(d.description, 25)} on ${shortDate(d.date)}`,
        description: `${formatCurrency(d.amountCents)} was charged ${n === 2 ? "twice" : `${n} times`} on the same day on ${accountNames.get(d.accountId) ?? "one account"}. If one is a hold or a mistake, the bank can reverse it.`,
        severity: "warning",
        impactCents: d.amountCents * (n - 1),
        period: shortDate(d.date),
        action: { type: "view_transactions", payload: { range: { start: d.date, end: addDaysIso(d.date, 1) }, search: d.description } },
        dismissKey: `dup_${d.key}_${d.date}_${d.amountCents}`,
      });
    }
  }

  // ── INSIGHT: overdraft_alert ────────────────────────────────────────────
  {
    const fees = expensesThisMonth.filter((r) => r.category_id === 19 || /OVERDRAFT FEE/i.test(r.description));
    if (fees.length > 0) {
      const total = fees.reduce((s, r) => s - r.amount_cents, 0);
      insights.push({
        id: `overdraft_alert_${thisMonth}`,
        type: "overdraft_alert",
        title: "Bank fees charged this month",
        description: `${plural(fees.length, "bank fee", "bank fees")} totalling ${formatCents(total)}. Keeping a $200 to $500 buffer prevents most of these.`,
        severity: "warning",
        impactCents: total,
        period: "this month",
        action: { type: "view_transactions", payload: { month: thisMonth, category: 19 } },
        dismissKey: `overdraft_alert_${thisMonth}`,
      });
    }
  }

  // ── INSIGHT: category_creep ──────────────────────────────────────────────
  // Compare avg spend over the last 3 complete months vs the 3 before them for each category.
  if (completeMonths.length >= 6) {
    const recent3Start = monthBounds(months12[3])[0];
    const older3Start  = monthBounds(months12[6])[0];

    const recentAvgs = await db.select<{ category_id: number; category_name: string; avg_spend: number }[]>(
      `SELECT t.category_id, c.name as category_name,
              CAST(AVG(monthly) AS INTEGER) as avg_spend
       FROM (SELECT tx.category_id, strftime('%Y-%m',tx.date) as mo,
                    ${categorySpendSql("tx", "ac")} as monthly
             FROM transactions tx JOIN accounts ac ON ac.id=tx.account_id
             WHERE tx.profile_id=? AND ac.excluded_from_insights=0 AND tx.date>=? AND tx.date<?
               AND (tx.category_id IS NULL OR tx.category_id NOT IN (20,29)) AND tx.category_id != 15
             GROUP BY tx.category_id, mo) t
       JOIN categories c ON t.category_id=c.id
       GROUP BY t.category_id HAVING COUNT(*)>=2`,
      [profileId, recent3Start, thisStart]
    );
    const olderAvgs = await db.select<{ category_id: number; avg_spend: number }[]>(
      `SELECT category_id, CAST(AVG(monthly) AS INTEGER) as avg_spend
       FROM (SELECT tx.category_id as category_id, strftime('%Y-%m',tx.date) as mo,
                    ${categorySpendSql("tx", "ac")} as monthly
             FROM transactions tx JOIN accounts ac ON ac.id=tx.account_id
             WHERE tx.profile_id=? AND ac.excluded_from_insights=0 AND tx.date>=? AND tx.date<?
               AND (tx.category_id IS NULL OR tx.category_id NOT IN (20,29))
             GROUP BY tx.category_id, mo) t
       GROUP BY category_id HAVING COUNT(*)>=2`,
      [profileId, older3Start, recent3Start]
    );
    const olderMap = new Map(olderAvgs.map((r) => [r.category_id, r.avg_spend]));
    for (const r of recentAvgs) {
      const older = olderMap.get(r.category_id);
      if (!older || older < 3000) continue; // skip low-value or no baseline
      const growthPct = Math.round(((r.avg_spend - older) / older) * 100);
      const deltaAnnual = (r.avg_spend - older) * 12;
      if (growthPct >= 30 && r.avg_spend - older >= 3000) {
        insights.push({
          id: `category_creep_${r.category_id}`,
          type: "category_creep",
          title: `${r.category_name} spending up ${growthPct}% over 6 months`,
          description: `Average ${formatCents(r.avg_spend)} a month over the last 3 months against ${formatCents(older)} before, about ${formatCents(deltaAnnual)} more a year if it continues.`,
          severity: "warning",
          impactCents: deltaAnnual,
          period: "a year",
          action: { type: "view_transactions", payload: { month: lastComplete?.month ?? thisMonth, category: r.category_id } },
          dismissKey: `category_creep_${r.category_id}_${thisMonth}`,
        });
      }
    }
  }

  // ── INSIGHT: year_end_projection ────────────────────────────────────────
  {
    const recentNets = completeMonths.slice(0, 3);
    if (recentNets.length >= 2 && recentNets.every((m) => m.income > 0)) {
      const avgNet = recentNets.reduce((s, m) => s + (m.income - m.expenses), 0) / recentNets.length;
      const monthsLeft = 12 - today.getMonth(); // months remaining inc. current
      const projected = Math.round(avgNet * monthsLeft);
      insights.push({
        id: `year_end_projection_${today.getFullYear()}`,
        type: "year_end_projection",
        title: projected >= 0
          ? `On pace to save ${formatCents(projected)} by year end`
          : `On pace to spend ${formatCents(Math.abs(projected))} more than you earn by year end`,
        description: `Based on your ${recentNets.length}-month average net of ${formatCents(avgNet)} a month with ${plural(monthsLeft, "month", "months")} left in ${today.getFullYear()}.`,
        severity: projected >= 0 ? "info" : "warning",
        impactCents: Math.abs(projected),
        period: "this year",
        dismissKey: `year_end_projection_${today.getFullYear()}`,
        richData: { projectedSavings: projected },
      });
    }
  }

  // ── INSIGHT: most_improved ───────────────────────────────────────────────
  // Last complete month against the one before it: comparing a half-finished month with a
  // whole one made every category look "improved" until the 30th.
  if (completeMonths.length >= 2) {
    const [currStart, currEnd] = monthBounds(completeMonths[0].month);
    const [prevStart, prevEnd] = monthBounds(completeMonths[1].month);
    const catTotals = async (start: string, end: string) => db.select<{ category_id: number; category_name: string; total: number }[]>(
      `SELECT t.category_id, c.name as category_name, ${categorySpendSql()} as total
       FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN categories c ON c.id=t.category_id
       WHERE t.profile_id=? AND a.excluded_from_insights=0 AND t.date>=? AND t.date<?
         AND t.category_id NOT IN (12, 15, 20, 22, 29)
       GROUP BY t.category_id`,
      [profileId, start, end]
    );
    const [currCats, prevCats] = await Promise.all([catTotals(currStart, currEnd), catTotals(prevStart, prevEnd)]);
    const currMap = new Map(currCats.map((c) => [c.category_id, c.total]));
    let bestCat: { name: string; pctDrop: number; prevTotal: number; thisTotal: number } | null = null;
    for (const prev of prevCats) {
      if (prev.total < 5000) continue;
      const thisTotal = currMap.get(prev.category_id) ?? 0;
      const pctDrop = Math.round(((prev.total - thisTotal) / prev.total) * 100);
      if (pctDrop >= 20 && prev.total - thisTotal >= 3000 && (!bestCat || pctDrop > bestCat.pctDrop)) {
        bestCat = { name: prev.category_name, pctDrop, prevTotal: prev.total, thisTotal };
      }
    }
    if (bestCat) {
      insights.push({
        id: `most_improved_${completeMonths[0].month}`,
        type: "most_improved",
        title: `Most improved in ${monthName(completeMonths[0].month)}: ${bestCat.name} down ${bestCat.pctDrop}% from ${monthName(completeMonths[1].month)}`,
        description: composeInsightText({
          type: "most_improved",
          currentValue: bestCat.thisTotal,
          currentLabel: formatCents(bestCat.thisTotal),
          previousValue: bestCat.prevTotal,
          previousLabel: formatCents(bestCat.prevTotal),
          higherIsBetter: false,
          variantSeed: `${profileId}:most_improved:${completeMonths[0].month}`,
          fallback: `${monthName(completeMonths[1].month)}: ${formatCents(bestCat.prevTotal)}. ${monthName(completeMonths[0].month)}: ${formatCents(bestCat.thisTotal)}. Keep it going.`,
        }),
        severity: "success",
        impactCents: bestCat.prevTotal - bestCat.thisTotal,
        period: "last month",
        dismissKey: `most_improved_${completeMonths[0].month}`,
        richData: { beforeAmount: bestCat.prevTotal, afterAmount: bestCat.thisTotal },
      });
    }
  }

  // ── INSIGHT: weekend_spending ────────────────────────────────────────────
  if (monthCount >= 3) {
    let weekendTotal = 0, weekdayTotal = 0;
    const weekendMerchants = new Map<string, { description: string; total: number }>();
    for (const r of expensesThisMonth) {
      const dow = new Date(`${r.date}T12:00:00`).getDay();
      const isWeekend = dow === 0 || dow === 6;
      if (isWeekend) {
        weekendTotal += -r.amount_cents;
        const key = merchantKey(r.description);
        const g = weekendMerchants.get(key) ?? { description: r.description, total: 0 };
        g.total += -r.amount_cents;
        weekendMerchants.set(key, g);
      } else weekdayTotal += -r.amount_cents;
    }
    const grandTotal = weekendTotal + weekdayTotal;
    if (grandTotal > 10000 && weekendTotal > 0) {
      const weekendPct = Math.round((weekendTotal / grandTotal) * 100);
      if (weekendPct >= 35) {
        const top = [...weekendMerchants.values()].sort((a, b) => b.total - a.total)[0];
        insights.push({
          id: `weekend_spending_${thisMonth}`,
          type: "weekend_spending",
          title: `${weekendPct}% of spending happens on weekends`,
          description: `Weekends ${formatCents(weekendTotal)}, weekdays ${formatCents(weekdayTotal)} this month.${top ? ` Top weekend merchant: ${truncate(top.description, 25)}.` : ""}`,
          severity: weekendPct >= 50 ? "warning" : "info",
          impactCents: weekendTotal,
          period: "this month",
          dismissKey: `weekend_spending_${thisMonth}`,
        });
      }
    }
  }

  // ── INSIGHT: spending_velocity ────────────────────────────────────────────
  // Are we spending faster than normal so far this month? Only when the data is current;
  // a stale import would make a full month look like a slow one.
  if (elapsedDays >= 5 && completeMonths.length >= 2 && currentSummary && coverageIsFresh(7)) {
    const currentSpend = currentSummary.expenses;
    const avgMonthly = avgOf(completeMonths.slice(0, 6));
    const pacedMonthly = Math.round((currentSpend / elapsedDays) * daysInThisMonth);
    const overshootPct = avgMonthly > 0 ? Math.round(((pacedMonthly - avgMonthly) / avgMonthly) * 100) : 0;
    if (avgMonthly > 5000 && pacedMonthly > avgMonthly * 1.15) {
      insights.push({
        id: `spending_velocity_${thisMonth}`,
        type: "spending_velocity",
        title: `Spending ${overshootPct}% above your usual pace this month`,
        description: `${plural(elapsedDays, "day", "days")} in, ${formatCents(currentSpend)} spent, on pace for ${formatCents(pacedMonthly)} against your average of ${formatCents(avgMonthly)}.`,
        severity: overshootPct >= 30 ? "warning" : "info",
        impactCents: pacedMonthly - Math.round(avgMonthly),
        period: "this month",
        action: { type: "view_transactions", payload: { month: thisMonth } },
        dismissKey: `spending_velocity_${thisMonth}`,
        richData: {
          paceMonthly: pacedMonthly,
          avgMonthly: Math.round(avgMonthly),
          potentialLabel: daysLeft > 0
            ? `Spending ${formatCents(Math.round((pacedMonthly - Math.round(avgMonthly)) / daysLeft))} a day less finishes the month on track`
            : undefined,
        },
      });
    }
  }

  // ── INSIGHT: expense_ratio_drift ─────────────────────────────────────────
  // Is the expense/income ratio getting worse over time?
  if (completeMonths.length >= 6) {
    const recent3 = completeMonths.slice(0, 3).filter((m) => m.income > 0);
    const older3  = completeMonths.slice(3, 6).filter((m) => m.income > 0);
    if (recent3.length >= 2 && older3.length >= 2) {
      const recentRate = aggregateSavingsRate(recent3);
      const olderRate  = aggregateSavingsRate(older3);
      const recentRatio = recentRate !== null ? 1 - recentRate : 1;
      const olderRatio  = olderRate !== null ? 1 - olderRate : 1;
      const driftPts = Math.round((recentRatio - olderRatio) * 100); // percentage points
      if (driftPts >= 8) {
        const recentSavingsPct = Math.round((1 - recentRatio) * 100);
        const avgRecentIncome = recent3.reduce((s, m) => s + m.income, 0) / recent3.length;
        insights.push({
          id: `expense_ratio_drift_${thisMonth}`,
          type: "expense_ratio_drift",
          title: `Savings margin compressed by ${driftPts} points over 6 months`,
          description: `Your expenses now take ${Math.round(recentRatio * 100)}% of income, up from ${Math.round(olderRatio * 100)}% three to six months ago. Current savings rate ${recentSavingsPct}%.`,
          severity: driftPts >= 15 ? "warning" : "info",
          impactCents: Math.round((driftPts / 100) * avgRecentIncome),
          period: "a month",
          dismissKey: `expense_ratio_drift_${thisMonth}`,
        });
      }
    }
  }

  // ── INSIGHT: fixed_costs_high (from the same maths as the page instrument) ──
  {
    const months = monthsWithIncome(shapeTxns, completeMonths.slice(0, 3).map((m) => m.month));
    const summary = summarizeFixedFlexible(shapeTxns, billRules, detectedLike, months, {
      incomeCents: plannedMonthlyIncomeCents(planned.activeRules),
      billsCents: plannedMonthlyBillsCents(planned.activeRules),
    });
    if (summary && summary.committedShare !== null && summary.avgIncomeCents >= 50000 && summary.committedShare >= 0.5) {
      const committed = summary.avgBillsCents + summary.avgRecurringCents;
      const incomeWord = summary.incomeBasis === "planned" ? "planned income" : "income";
      insights.push({
        id: `fixed_costs_${thisMonth}`,
        type: "fixed_costs_high",
        title: `Fixed costs take ${Math.round(summary.committedShare * 100)}% of your ${incomeWord}`,
        description: `About ${formatCents(committed)} of your ${formatCents(summary.avgIncomeCents)} a month goes to scheduled bills and recurring charges, leaving ${formatCents(summary.avgIncomeCents - committed)} for everything else${summary.incomeBasis === "planned" ? ", measured against the income you scheduled in Plan" : `, averaged over ${plural(months.length, "complete month", "complete months")}`}.`,
        severity: summary.committedShare >= 0.6 ? "warning" : "info",
        impactCents: Math.round((summary.committedShare - 0.5) * summary.avgIncomeCents),
        period: "a month",
        action: { type: "open_plan", payload: {} },
        dismissKey: `fixed_costs_${thisMonth}`,
        richData: { shareBar: { segments: [
          { label: "Bills", cents: summary.avgBillsCents, kind: "bills" },
          { label: "Recurring", cents: summary.avgRecurringCents, kind: "recurring" },
          { label: "Flexible", cents: summary.avgFlexibleCents, kind: "flexible" },
          { label: "Left", cents: Math.max(0, summary.avgLeftCents), kind: "left" },
        ] } },
      });
    }
  }

  // ── INSIGHT: no_spend_days ──────────────────────────────────────────────
  if (lastComplete) {
    const current = countNoSpendDays(shapeTxns, lastComplete.month, billRules, detectedLike);
    const previous = completeMonths[1] ? countNoSpendDays(shapeTxns, completeMonths[1].month, billRules, detectedLike) : null;
    const comparable = previous && previous.expenseCount >= 15 ? previous : null;
    if (current.expenseCount >= 15 && (current.noSpendDays >= 10 || (comparable && current.noSpendDays - comparable.noSpendDays >= 3))) {
      insights.push({
        id: `nospend_${lastComplete.month}`,
        type: "no_spend_days",
        title: `${plural(current.noSpendDays, "no-spend day", "no-spend days")} in ${monthName(lastComplete.month)}${comparable ? `, ${current.noSpendDays >= comparable.noSpendDays ? "up" : "down"} from ${comparable.noSpendDays} in ${monthName(comparable.month)}` : ""}`,
        description: "Days with no flexible spending. Scheduled bills and recurring charges do not count against it.",
        severity: "success",
        period: "last month",
        dismissKey: `nospend_${lastComplete.month}`,
      });
    }
  }

  // ── INSIGHT: payday_burst ────────────────────────────────────────────────
  {
    const months = monthsWithIncome(shapeTxns, completeMonths.slice(0, 2).map((m) => m.month));
    if (months.length === 2) {
      const bursts = months.map((m) => paydayBurstShare(shapeTxns, m, billRules, detectedLike));
      if (bursts.every((b) => b !== null && b.share >= 0.4 && b.share >= 1.8 * b.coveredShare)) {
        const avgShare = bursts.reduce((s, b) => s + (b?.share ?? 0), 0) / bursts.length;
        insights.push({
          id: `payday_${quarterKey(today)}`,
          type: "payday_burst",
          title: `${Math.round(avgShare * 100)}% of your flexible spending happens within three days of payday`,
          description: `Across ${monthName(months[1])} and ${monthName(months[0])}. Spreading it out makes the rest of each pay period easier.`,
          severity: "info",
          period: "2 months",
          dismissKey: `payday_${quarterKey(today)}`,
        });
      }
    }
  }

  // ── INSIGHT: annual_renewal ─────────────────────────────────────────────
  if (earliestIso && daysBetweenIso(earliestIso, todayIso) >= 395) {
    const yearRows = await db.select<{ description: string; amount_cents: number; date: string }[]>(
      `SELECT t.description, t.amount_cents, t.date
       FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id=? AND a.excluded_from_insights=0 AND a.account_type!='loan'
         AND t.amount_cents<=-2000 AND t.date>=? AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))`,
      [profileId, addDaysIso(todayIso, -400)]
    );
    for (const renewal of findAnnualCharges(yearRows, todayIso).filter((r) => !recurringKeys.has(r.key)).slice(0, 3)) {
      insights.push({
        id: `annual_${renewal.key}_${today.getFullYear()}`,
        type: "annual_renewal",
        title: `Annual charge coming up: ${truncate(renewal.description, 28)}, about ${formatCents(renewal.amountCents)} around ${shortDate(renewal.expectedDate)}`,
        description: `Seen ${renewal.occurrences} times about a year apart, most recently on ${formatDate(renewal.lastDate)}. Scheduling it in Plan keeps it out of the surprise column.`,
        severity: "info",
        impactCents: renewal.amountCents,
        period: "next 30 days",
        action: { type: "open_plan", payload: {} },
        dismissKey: `annual_${renewal.key}_${today.getFullYear()}`,
      });
    }
  }

  // ── INSIGHT: large_purchase ─────────────────────────────────────────────
  {
    const baseline = recent
      .filter((r) => r.date < thisStart && r.amount_cents < 0 && !isExcludedCategory(r.category_id) && r.category_id !== 12 && r.category_id !== 22)
      .map((r) => -r.amount_cents);
    if (baseline.length >= 50) {
      const p95 = percentile(baseline, 0.95);
      const threshold = Math.max(20000, 3 * p95);
      const since = addDaysIso(todayIso, -14);
      const candidates = recent
        .filter((r) => r.date >= since && r.amount_cents < 0 && -r.amount_cents >= threshold
          && !isExcludedCategory(r.category_id) && r.category_id !== 12 && r.category_id !== 22
          && ["flexible", "oneoff"].includes(classifyExpense({ date: r.date, amount_cents: r.amount_cents, description: r.description, account_type: r.account_type, category_id: r.category_id }, billRules, detectedLike)))
        .sort((a, b) => a.amount_cents - b.amount_cents)
        .slice(0, 2);
      for (const r of candidates) {
        insights.push({
          id: `large_${r.id}`,
          type: "large_purchase",
          title: `Large purchase: ${formatCents(-r.amount_cents)} at ${truncate(r.description, 25)} on ${shortDate(r.date)}`,
          description: `Your typical expense tops out around ${formatCents(p95)}. Worth a glance if you did not expect it.`,
          severity: "info",
          impactCents: -r.amount_cents,
          period: shortDate(r.date),
          action: { type: "view_transactions", payload: { range: { start: r.date, end: addDaysIso(r.date, 1) }, search: r.description } },
          dismissKey: `large_${r.id}`,
        });
      }
    }
  }

  // ── INSIGHT: uncategorized_share (housekeeping) ─────────────────────────
  {
    const window = lastComplete?.month ?? (elapsedDays >= 10 ? thisMonth : null);
    if (window) {
      const [wStart, wEnd] = monthBounds(window);
      const rows = recent.filter((r) => r.date >= wStart && r.date < wEnd && r.amount_cents < 0 && !isExcludedCategory(r.category_id));
      const total = rows.reduce((s, r) => s - r.amount_cents, 0);
      const uncat = rows.filter((r) => r.category_id === null || r.category_id === 15);
      const uncatCents = uncat.reduce((s, r) => s - r.amount_cents, 0);
      if (rows.length >= 20 && total >= 20000 && ((uncatCents / total >= 0.1 && uncatCents >= 10000) || uncat.length >= 15)) {
        insights.push({
          id: `uncat_${window}`,
          type: "uncategorized_share",
          title: `${formatCents(uncatCents)} of ${window === thisMonth ? "this month's" : `${monthName(window)}'s`} spending is uncategorized`,
          description: `${plural(uncat.length, "purchase has", "purchases have")} no category, so budgets and category insights skip that money.`,
          severity: "info",
          impactCents: uncatCents,
          period: window === thisMonth ? "this month" : "last month",
          action: { type: "view_transactions", payload: { month: window, category: 15 } },
          dismissKey: `uncat_${window}`,
        });
      }
    }
  }

  // ── INSIGHT: stale_data (housekeeping) ──────────────────────────────────
  {
    const stale = freshnessRows
      .filter((r) => daysBetweenIso(r.first_date, r.last_date) >= 30)
      .map((r) => {
        const manualOnly = r.manual_n === r.n;
        const threshold = manualOnly || (r.account_type !== "checking" && r.account_type !== "credit") ? 45 : 21;
        return { ...r, age: daysBetweenIso(r.last_date, todayIso), threshold };
      })
      .filter((r) => r.age > r.threshold)
      .sort((a, b) => b.age - a.age);
    if (stale.length > 0) {
      const newestLast = stale.reduce((max, r) => (r.last_date > max ? r.last_date : max), stale[0].last_date);
      const key = `stale_${stale.map((r) => r.id).join("_")}_${newestLast}`;
      insights.push({
        id: key,
        type: "stale_data",
        title: stale.length === 1
          ? `${stale[0].name} has not been updated in ${plural(stale[0].age, "day", "days")}`
          : `${stale.length} accounts have not been updated in over ${stale[stale.length - 1].age} days`,
        description: `Insights about pace, budgets and balances use data through ${formatDate(newestLast)}. Import a newer statement to bring them current.${stale.length > 1 ? ` Oldest: ${listClauses(stale.slice(0, 3).map((r) => r.name))}.` : ""}`,
        severity: stale[0].age > 45 ? "warning" : "info",
        period: `since ${shortDate(newestLast)}`,
        action: { type: "import", payload: {} },
        dismissKey: key,
      });
    }
  }

  // ── INSIGHT: goal_off_track / goal_projection ───────────────────────────
  {
    const goals = await evaluateGoals(db, profileId, thisMonth, today);
    const positiveNets = completeMonths.slice(0, 3).map((m) => m.income - m.expenses).filter((n) => n > 0);
    const savingsPace = completeMonths.slice(0, 3).length > 0
      ? Math.round(positiveNets.reduce((s, n) => s + n, 0) / completeMonths.slice(0, 3).length) : 0;
    for (const g of goals) {
      if (g.noBalanceData || g.noBudgetData) continue;
      const offKey = `goal_off_${g.id}_${thisMonth}`;
      const etaKey = `goal_eta_${g.id}_${thisMonth}`;
      if (g.type === "balance_floor" && g.current_cents < g.target_cents) {
        const gap = g.target_cents - g.current_cents;
        insights.push({
          id: offKey, type: "goal_off_track",
          title: `${g.name} is ${formatCents(gap)} below its ${formatCents(g.target_cents)} floor`,
          description: `Your checking balance is ${formatCents(g.current_cents)}. This goal asks for at least ${formatCents(g.target_cents)} on hand.`,
          severity: "warning", impactCents: gap, period: "today",
          action: { type: "open_goals", payload: {} }, dismissKey: offKey,
        });
      } else if (g.type === "reduce_spend") {
        const scope = g.category_name ? ` on ${g.category_name}` : "";
        if (g.current_cents > g.target_cents) {
          const over = g.current_cents - g.target_cents;
          insights.push({
            id: offKey, type: "goal_off_track",
            title: `${g.name}: ${formatCents(over)} over the ${formatCents(g.target_cents)} limit`,
            description: `Spent ${formatCents(g.current_cents)} so far in ${monthName(thisMonth)}${scope} with ${plural(daysLeft, "day", "days")} left.`,
            severity: "warning", impactCents: over, period: "this month",
            action: { type: "open_goals", payload: {} }, dismissKey: offKey,
          });
        } else if (elapsedDays >= 10 && elapsedDays / daysInThisMonth <= 0.75 && coverageIsFresh(3) && g.current_cents >= g.target_cents * 0.9) {
          const paced = Math.round((g.current_cents / elapsedDays) * daysInThisMonth);
          insights.push({
            id: offKey, type: "goal_off_track",
            title: `${g.name} is on pace to pass its ${formatCents(g.target_cents)} limit`,
            description: `${formatCents(g.current_cents)} spent${scope} in ${plural(elapsedDays, "day", "days")}, on pace for ${formatCents(paced)}.`,
            severity: "info", impactCents: Math.max(0, paced - g.target_cents), period: "this month",
            action: { type: "open_goals", payload: {} }, dismissKey: offKey,
          });
        }
      } else if (g.type === "budget_streak" && lastComplete && g.current_streak === 0 && (g.target_months ?? 3) >= 2) {
        insights.push({
          id: offKey, type: "goal_off_track",
          title: `${g.name}: the streak starts again`,
          description: `${g.category_name ?? "This category"} went over its budget in ${monthName(lastComplete.month)}, so the ${plural(g.target_months ?? 3, "month", "months")} streak restarts from zero.`,
          severity: "info", period: "last month",
          action: { type: "open_goals", payload: {} }, dismissKey: offKey,
        });
      } else if (g.type === "savings_rate_habit" && lastComplete && g.current_streak === 0 && lastComplete.income > 0) {
        const rate = ((lastComplete.income - lastComplete.expenses) / lastComplete.income) * 100;
        const targetPct = g.target_cents / 100;
        if (rate < targetPct) {
          insights.push({
            id: offKey, type: "goal_off_track",
            title: `${g.name}: ${monthName(lastComplete.month)} came in at ${Math.round(rate)}% against a ${targetPct}% target`,
            description: `Income ${formatCents(lastComplete.income)}, spending ${formatCents(lastComplete.expenses)}.`,
            severity: "info", impactCents: Math.max(0, Math.round(((targetPct - rate) / 100) * lastComplete.income)), period: "last month",
            action: { type: "open_goals", payload: {} }, dismissKey: offKey,
          });
        }
      } else if (g.type === "savings_target") {
        const remaining = g.target_cents - g.current_cents;
        if (remaining > 0 && completeMonths.length >= 2) {
          const months = projectGoalCompletion(remaining, savingsPace);
          insights.push({
            id: etaKey, type: "goal_projection",
            title: months !== null
              ? `${g.name} reaches ${formatCents(g.target_cents)} in about ${plural(months, "month", "months")} at this pace`
              : `${g.name} is not gaining ground`,
            description: months !== null
              ? `${formatCents(g.current_cents)} saved so far, adding about ${formatCents(savingsPace)} a month.`
              : `No month in the last three ended with money left over, so the ${formatCents(remaining)} still needed is not shrinking.`,
            severity: "info", period: "3 months",
            action: { type: "open_goals", payload: {} }, dismissKey: etaKey,
          });
        }
      } else if (g.type === "debt_paydown") {
        const remaining = g.current_cents - g.target_cents;
        if (remaining <= 0) continue;
        const accountIds = g.account_id
          ? [g.account_id]
          : (await db.select<{ id: number }[]>("SELECT id FROM accounts WHERE profile_id=? AND account_type IN ('credit','loan') AND hidden_from_dashboard=0", [profileId])).map((r) => r.id);
        const histories = await Promise.all(accountIds.map((id) => getLoanBalanceHistory(id)));
        const paces = histories.map((h) => monthlyPaceFromBalances(h.map((p) => ({ date: p.date, value: p.value * 100 })))).filter((p) => p !== null);
        if (paces.length === 0) continue;
        const pace = paces.reduce((s, p) => s + p!.paceCents, 0);
        const change = paces.reduce((s, p) => s + p!.changeCents, 0);
        const spanMonths = Math.max(1, Math.round(Math.max(...paces.map((p) => p!.days)) / 30.4));
        const months = projectGoalCompletion(remaining, pace);
        if (months === null || months === 0) continue;
        insights.push({
          id: etaKey, type: "goal_projection",
          title: `${g.name} reaches ${g.target_cents === 0 ? "$0" : formatCents(g.target_cents)} in about ${plural(months, "month", "months")} at this pace`,
          description: `Balances fell ${formatCents(change)} over the last ${plural(spanMonths, "month", "months")}, about ${formatCents(pace)} a month.`,
          severity: "info", period: `${spanMonths} months`,
          action: { type: "open_goals", payload: {} }, dismissKey: etaKey,
        });
      }
    }
  }

  // ── INSIGHT: net_worth_growing / net_worth_declining ─────────────────────
  const [nowNetWorth, priorNetWorth] = await Promise.all([
    computeNetWorth([profileId]),
    computeNetWorth([profileId], thisStart),
  ]);
  const netWorthDelta = nowNetWorth.netWorthCents - priorNetWorth.netWorthCents;
  if (Math.abs(netWorthDelta) >= 20000) {
    // At least $200 moved since the start of this month
    const fallback = `Your net worth (cash plus investments minus debt) went from ${formatCents(priorNetWorth.netWorthCents)} to ${formatCents(nowNetWorth.netWorthCents)}.`;
    if (netWorthDelta > 0) {
      insights.push({
        id: `net_worth_growing_${thisMonth}`,
        type: "net_worth_growing",
        title: `Net worth grew by ${formatCents(netWorthDelta)} this month`,
        description: composeInsightText({
          type: "net_worth_growing",
          currentValue: nowNetWorth.netWorthCents,
          currentLabel: formatCents(nowNetWorth.netWorthCents),
          previousValue: priorNetWorth.netWorthCents,
          previousLabel: formatCents(priorNetWorth.netWorthCents),
          higherIsBetter: true,
          variantSeed: `${profileId}:net_worth_growing:${thisMonth}`,
          fallback,
        }),
        severity: "success",
        impactCents: netWorthDelta,
        period: "this month",
        dismissKey: `net_worth_growing_${thisMonth}`,
      });
    } else {
      insights.push({
        id: `net_worth_declining_${thisMonth}`,
        type: "net_worth_declining",
        title: `Net worth dropped by ${formatCents(Math.abs(netWorthDelta))} this month`,
        description: composeInsightText({
          type: "net_worth_declining",
          currentValue: nowNetWorth.netWorthCents,
          currentLabel: formatCents(nowNetWorth.netWorthCents),
          previousValue: priorNetWorth.netWorthCents,
          previousLabel: formatCents(priorNetWorth.netWorthCents),
          higherIsBetter: true,
          variantSeed: `${profileId}:net_worth_declining:${thisMonth}`,
          fallback,
        }),
        severity: "warning",
        impactCents: Math.abs(netWorthDelta),
        period: "this month",
        dismissKey: `net_worth_declining_${thisMonth}`,
      });
    }
  }

  // ── INSIGHT: investment_performance ───────────────────────────────────────
  const investmentReturn = await computeInvestmentReturn([profileId]);
  if (investmentReturn.hasCostBasis) {
    const returnPct = investmentReturn.annualizedReturnPct ?? investmentReturn.absoluteReturnPct ?? 0;
    const kind = investmentReturn.annualizedReturnPct !== null ? "annualized" : "overall";
    insights.push({
      id: `investment_performance_${thisMonth}`,
      type: "investment_performance",
      title: `Portfolio ${returnPct >= 0 ? "up" : "down"} ${Math.abs(returnPct).toFixed(1)}% (${kind})`,
      description: `Your holdings are ${returnPct >= 0 ? "up" : "down"} ${Math.abs(returnPct).toFixed(1)}% ${kind} against cost basis, compared with the long-run market average of about ${AVG_US_MARKET_RETURN_PCT}% a year.`,
      severity: returnPct >= AVG_US_MARKET_RETURN_PCT ? "success" : returnPct < 0 ? "warning" : "info",
      dismissKey: `investment_performance_${thisMonth}`,
    });
  }

  // ── INSIGHT: dividend_income_projected ─────────────────────────────────────
  const [dividendRow] = await db.select<{ total: number | null }[]>(
    `SELECT SUM(h.est_annual_income_cents) as total FROM holdings h
     WHERE h.profile_id=? AND ${latestHoldingPerAccount()}`,
    [profileId]
  );
  if ((dividendRow?.total ?? 0) > 0) {
    const dividendTotal = dividendRow!.total!;
    insights.push({
      id: `dividend_income_projected_${thisMonth}`,
      type: "dividend_income_projected",
      title: `Projected ${formatCents(dividendTotal)} a year in dividend income`,
      description: `Based on your current holdings' dividend rates, you are on pace to earn about ${formatCents(dividendTotal)} in dividend and distribution income this year.`,
      severity: "success",
      impactCents: dividendTotal,
      period: "a year",
      dismissKey: `dividend_income_projected_${thisMonth}`,
    });
  }

  // ── INSIGHT: investment_income_received ────────────────────────────────────
  // The counterpart to the projection above: dividends/interest that actually landed in the
  // account this year, from imported statement activity.
  const [incomeRow] = await db.select<{ total: number | null }[]>(
    `SELECT SUM(ABS(amount_cents)) as total FROM investment_activity
     WHERE profile_id=? AND activity_type IN ('dividend','reinvest','interest')
       AND trade_date >= ?`,
    [profileId, `${thisMonth.slice(0, 4)}-01-01`]
  );
  if ((incomeRow?.total ?? 0) > 0) {
    const received = incomeRow!.total!;
    insights.push({
      id: `investment_income_received_${thisMonth}`,
      type: "investment_income_received",
      title: `${formatCents(received)} in investment income received this year`,
      description: `Your imported statements show ${formatCents(received)} of dividends and interest paid into your investment accounts so far this year.`,
      severity: "success",
      impactCents: received,
      period: "this year",
      dismissKey: `investment_income_received_${thisMonth}`,
    });
  }

  // ── INSIGHT: realized_gains_ytd ────────────────────────────────────────────
  // Statements report this as an account-level total rather than per sale, so take the most
  // recent statement's own YTD figure instead of summing activity rows.
  const [realizedRow] = await db.select<{ total: number | null }[]>(
    `SELECT SUM(realized_gain_ytd_cents) as total FROM investment_summaries s
     WHERE s.profile_id=? AND s.realized_gain_ytd_cents IS NOT NULL
       AND s.period_end = (SELECT MAX(period_end) FROM investment_summaries s2
                           WHERE s2.account_id = s.account_id)`,
    [profileId]
  );
  if (realizedRow?.total) {
    const realized = realizedRow.total;
    insights.push({
      id: `realized_gains_ytd_${thisMonth}`,
      type: "realized_gains_ytd",
      title: `${formatCents(Math.abs(realized))} in realized ${realized >= 0 ? "gains" : "losses"} this year`,
      description: realized >= 0
        ? `Sales in your investment accounts have realized ${formatCents(realized)} of gains year to date. These are generally taxable in a non-retirement account.`
        : `Sales in your investment accounts have realized ${formatCents(Math.abs(realized))} of losses year to date, which may offset gains at tax time.`,
      severity: realized >= 0 ? "success" : "info",
      impactCents: Math.abs(realized),
      period: "this year",
      dismissKey: `realized_gains_ytd_${thisMonth}`,
    });
  }

  // ── INSIGHT: investment_fees ───────────────────────────────────────────────
  {
    const yearAgo = addDaysIso(todayIso, -365);
    const [[summaryFees], [activityFees]] = await Promise.all([
      db.select<{ fees: number; accounts: number }[]>(
        `SELECT COALESCE(SUM(fees_cents),0) as fees, COUNT(DISTINCT account_id) as accounts
         FROM investment_summaries WHERE profile_id=? AND period_end>=?`,
        [profileId, yearAgo]
      ),
      db.select<{ fees: number }[]>(
        `SELECT COALESCE(SUM(ABS(amount_cents)),0) as fees FROM investment_activity
         WHERE profile_id=? AND activity_type IN ('fee','tax') AND trade_date>=?
           AND account_id NOT IN (SELECT DISTINCT account_id FROM investment_summaries WHERE profile_id=? AND period_end>=?)`,
        [profileId, yearAgo, profileId, yearAgo]
      ),
    ]);
    const totalFees = Math.abs(summaryFees?.fees ?? 0) + (activityFees?.fees ?? 0);
    if (totalFees >= 500) {
      const share = nowNetWorth.investmentCents > 0 ? (totalFees / nowNetWorth.investmentCents) * 100 : null;
      insights.push({
        id: `inv_fees_${quarterKey(today)}`,
        type: "investment_fees",
        title: `${formatCents(totalFees)} in investment fees over the last 12 months`,
        description: share !== null
          ? `That is ${share.toFixed(1)}% of your holdings.${share >= 1 ? " Index funds typically charge under 0.2% a year." : ""}`
          : "From the fee lines on your imported statements.",
        severity: share !== null && share >= 1 ? "warning" : "info",
        impactCents: totalFees,
        period: "a year",
        dismissKey: `inv_fees_${quarterKey(today)}`,
      });
    }
  }

  // ── INSIGHT: portfolio_concentration_risk ──────────────────────────────────
  const holdingRows = await db.select<{ symbol: string | null; description: string; market_value_cents: number | null }[]>(
    `SELECT h.symbol, h.description, h.market_value_cents FROM holdings h
     WHERE h.profile_id=? AND ${latestHoldingPerAccount()}`,
    [profileId]
  );
  const holdingGroups = new Map<string, { label: string; value: number }>();
  for (const h of holdingRows) {
    const key = h.symbol ?? h.description;
    const g = holdingGroups.get(key) ?? { label: h.symbol ?? h.description, value: 0 };
    g.value += h.market_value_cents ?? 0;
    holdingGroups.set(key, g);
  }
  if (holdingGroups.size >= 2) {
    const totalValue = [...holdingGroups.values()].reduce((s, g) => s + g.value, 0);
    const topHolding = [...holdingGroups.values()].sort((a, b) => b.value - a.value)[0];
    const sharePct = totalValue > 0 ? (topHolding.value / totalValue) * 100 : 0;
    if (sharePct >= 25) {
      insights.push({
        id: `portfolio_concentration_risk_${thisMonth}`,
        type: "portfolio_concentration_risk",
        title: `${topHolding.label} is ${Math.round(sharePct)}% of your portfolio`,
        description: `${topHolding.label} makes up ${Math.round(sharePct)}% of your total holdings value (${formatCents(topHolding.value)} of ${formatCents(totalValue)}). Concentrating this much in one position adds risk. Consider whether this still matches your intended allocation.`,
        severity: sharePct >= 50 ? "warning" : "info",
        impactCents: topHolding.value,
        period: "held",
        dismissKey: `portfolio_concentration_risk_${thisMonth}`,
      });
    }
  }

  return rankInsights(insights);
}

/**
 * Public entry-point. Pass one or more profile IDs.
 * In single-profile mode this is a thin pass-through.
 * In multi-profile mode, insights are gathered per-profile and merged/deduped, then ranked
 * again so the combined list reads in one order.
 */
export async function generateInsights(profileIds: number[]): Promise<Insight[]> {
  if (profileIds.length === 1) return _insightsForProfile(profileIds[0]);

  const results = await Promise.all(profileIds.map((id) => _insightsForProfile(id)));
  const merged: Insight[] = [];
  const seen = new Set<string>();
  for (const list of results) {
    for (const ins of list) {
      if (!seen.has(ins.id)) {
        seen.add(ins.id);
        merged.push(ins);
      }
    }
  }
  return rankInsights(merged);
}

// ─── Spending Profile summary ─────────────────────────────────────────────────

export interface SpendingProfile {
  avgMonthlyIncome: number;
  avgMonthlyExpenses: number;
  avgSavingsRate: number;
  topCategory: string;
  topCategoryAvg: number;
  monthsAnalysed: number;
}

export async function getSpendingProfile(profileIds: number[]): Promise<SpendingProfile | null> {
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");
  const [dataRange] = await db.select<{ months: number }[]>(
    `SELECT COUNT(DISTINCT strftime('%Y-%m', date)) as months FROM transactions WHERE profile_id IN (${ph})`,
    [...profileIds]
  );
  const months = dataRange?.months ?? 0;
  if (months < 1) return null;

  const now = new Date();
  const startDate = toISODate(new Date(now.getFullYear(), now.getMonth() - 5, 1));

  // Averages cover whole months only - the current month is partly elapsed, so folding it in
  // would drag every average down and make the figures shift daily. A brand-new profile with
  // nothing but this month's data still uses it, otherwise there'd be nothing to show.
  const endDate = months >= 2
    ? toISODate(new Date(now.getFullYear(), now.getMonth(), 1))
    : toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 1));

  const [summary] = await db.select<{ avg_income: number; avg_expenses: number }[]>(
    `SELECT AVG(income) as avg_income, AVG(expenses) as avg_expenses
     FROM (
       SELECT ${INCOME_SUM_SQL} as income,
              ${EXPENSE_SUM_SQL} as expenses
       FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND a.excluded_from_insights=0
       GROUP BY strftime('%Y-%m', t.date)
     )`,
    [...profileIds, startDate, endDate]
  );

  const [topCat] = await db.select<{ name: string; avg_spend: number }[]>(
    `SELECT c.name, CAST(AVG(monthly_spend) AS INTEGER) as avg_spend
     FROM (
       SELECT tx.category_id, strftime('%Y-%m', tx.date) as mo,
              ${categorySpendSql("tx", "ac")} as monthly_spend
       FROM transactions tx JOIN accounts ac ON ac.id=tx.account_id
       WHERE tx.profile_id IN (${ph}) AND tx.date>=? AND ac.excluded_from_insights=0
         AND (tx.category_id IS NULL OR tx.category_id NOT IN (20,29))
       GROUP BY tx.category_id, mo
     ) t JOIN categories c ON t.category_id=c.id
     WHERE c.id != 15
     GROUP BY t.category_id ORDER BY avg_spend DESC LIMIT 1`,
    [...profileIds, startDate]
  );

  const avgInc = summary?.avg_income ?? 0;
  const avgExp = summary?.avg_expenses ?? 0;
  const savingsRate = avgInc > 0 ? (avgInc - avgExp) / avgInc : 0;

  return {
    avgMonthlyIncome: Math.round(avgInc),
    avgMonthlyExpenses: Math.round(avgExp),
    avgSavingsRate: savingsRate,
    topCategory: topCat?.name ?? "No data",
    topCategoryAvg: topCat?.avg_spend ?? 0,
    monthsAnalysed: Math.min(months, 6),
  };
}

// ─── Savings rate history (for sparkline) ────────────────────────────────────

export async function getSavingsHistory(
  profileIds: number[],
  months = 12
): Promise<{ month: string; rate: number; net: number }[]> {
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");
  const now = new Date();
  const startDate = toISODate(new Date(now.getFullYear(), now.getMonth() - (months - 1), 1));
  const rows = await db.select<{ month: string; income: number; expenses: number }[]>(
    `SELECT strftime('%Y-%m', t.date) as month,
            ${INCOME_SUM_SQL} as income,
            ${EXPENSE_SUM_SQL} as expenses
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.date>=? AND a.excluded_from_insights=0
     GROUP BY month ORDER BY month`,
    [...profileIds, startDate]
  );
  return rows.map((r) => ({
    month: r.month,
    net: r.income - r.expenses,
    rate: r.income > 0 ? Math.round(((r.income - r.expenses) / r.income) * 100) : 0,
  }));
}

// ─── Financial Health Score ───────────────────────────────────────────────────

export async function computeHealthScore(profileIds: number[]): Promise<HealthScore> {
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");

  const now = new Date();
  const threeAgo = toISODate(new Date(now.getFullYear(), now.getMonth() - 3, 1));
  const sixAgo   = toISODate(new Date(now.getFullYear(), now.getMonth() - 6, 1));
  const msStart  = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
  const msEnd    = toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 1));

  // ── 1. Savings Rate (40 pts) — the last 3 COMPLETE months of income that didn't go back
  // out. Credit-card purchases count as spending here (they are), while the card payment
  // itself is a Transfer and excluded, so nothing is double-counted ──────────────
  const srRows = await db.select<{ month: string; income: number; expenses: number }[]>(
    `SELECT strftime('%Y-%m', t.date) as month,
       ${INCOME_SUM_SQL} as income,
       ${EXPENSE_SUM_SQL} as expenses
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND a.excluded_from_insights=0
     GROUP BY month ORDER BY month DESC LIMIT 3`,
    [...profileIds, threeAgo, msStart]
  );
  const avgRate = aggregateSavingsRate(srRows) ?? 0;
  const savingsScore = avgRate >= 0.20 ? 40 : avgRate >= 0.15 ? 30 : avgRate >= 0.10 ? 20 : avgRate >= 0.05 ? 10 : 0;

  // ── 2. Budget Health (30 pts) — this month ──────────────────────────────
  const budgets = await db.select<BudgetDefinition[]>(
    `SELECT b.*,c.name as category_name,c.parent_id as category_parent_id FROM budgets b JOIN categories c ON c.id=b.category_id WHERE (b.profile_id IN (${ph}) AND b.is_global=0) OR b.is_global=1`,
    [...profileIds]
  );
  let budgetScore = 15;
  if (budgets.length > 0) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - (now.getDay() + 6) % 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);
    const evaluations = await Promise.all(budgets.map((budget) => evaluateBudgetPeriod(db, budget,
      budget.is_global ? profileIds : [budget.profile_id],
      budget.period === "weekly" ? toISODate(weekStart) : msStart,
      budget.period === "weekly" ? toISODate(weekEnd) : msEnd, true)));
    const known = evaluations.filter((period) => period.covered);
    if (known.length > 0) {
      const pct = known.filter((period) => period.onTrack).length / known.length;
      budgetScore = pct >= 1.0 ? 30 : pct >= 0.8 ? 24 : pct >= 0.6 ? 18 : pct >= 0.4 ? 12 : 6;
    }
  }

  // ── 3. Balance Runway (20 pts) — liquid cash only, not credit card debt ──
  const [balRow] = await db.select<{ balance_cents: number | null }[]>(
    `SELECT COALESCE(SUM(${latestBalancePerAccountSql()}), 0) as balance_cents
     FROM accounts a
     WHERE a.profile_id IN (${ph}) AND a.account_type='checking' AND a.excluded_from_insights=0`,
    [...profileIds]
  );
  let balanceScore = 10;
  if ((balRow?.balance_cents ?? 0) > 0) {
    const [expRow] = await db.select<{ avg_exp: number }[]>(
      `SELECT AVG(me) as avg_exp FROM (
         SELECT ${EXPENSE_SUM_SQL} as me
         FROM transactions t JOIN accounts a ON a.id=t.account_id
         WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND a.excluded_from_insights=0
         GROUP BY strftime('%Y-%m', t.date))`,
      [...profileIds, threeAgo, msStart]
    );
    const avgExp = expRow?.avg_exp ?? 0;
    if (avgExp > 0) {
      const rw = balRow!.balance_cents! / avgExp;
      balanceScore = rw >= 6 ? 20 : rw >= 3 ? 15 : rw >= 1 ? 8 : 2;
    }
  }

  // ── 4. Income Stability (10 pts) — 6-month variance ───────────────────
  const incRows = await db.select<{ income: number }[]>(
    `SELECT ${INCOME_SUM_SQL} as income
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND a.excluded_from_insights=0
     GROUP BY strftime('%Y-%m', t.date)`,
    [...profileIds, sixAgo, msStart]
  );
  const incomes = incRows.filter(r => r.income > 0).map(r => r.income);
  let incomeScore = 5;
  if (incomes.length >= 2) {
    const avg = incomes.reduce((a, b) => a + b, 0) / incomes.length;
    const maxDev = Math.max(...incomes.map(v => Math.abs(v - avg) / avg));
    incomeScore = maxDev < 0.10 ? 10 : maxDev < 0.25 ? 7 : maxDev < 0.40 ? 4 : 1;
  }

  const total = savingsScore + budgetScore + balanceScore + incomeScore;
  const { grade, label, color, tone } = scoreGrade(total);

  return {
    total, grade, label, color, tone,
    components: {
      savingsRate:     { score: savingsScore,  max: 40, pct: Math.round((savingsScore / 40)  * 100) },
      budgetHealth:    { score: budgetScore,   max: 30, pct: Math.round((budgetScore / 30)   * 100) },
      balanceRunway:   { score: balanceScore,  max: 20, pct: Math.round((balanceScore / 20)  * 100) },
      incomeStability: { score: incomeScore,   max: 10, pct: Math.round((incomeScore / 10)   * 100) },
    },
  };
}

/**
 * Standalone Credit Card Health score (0-100), benchmarked against the average
 * U.S. credit card balance rather than folded into the main Health Score.
 * Scores the current balance against the benchmark, then nudges +/-10 points
 * for whether the balance shrank or grew over the current month.
 * Returns hasData=false when the profile(s) have no credit card account at all.
 */
export async function computeCreditCardHealthScore(profileIds: number[]): Promise<CreditCardHealthScore> {
  const benchmarkCents = AVG_US_CREDIT_CARD_DEBT_CENTS;
  const empty = (): CreditCardHealthScore => {
    const { grade, label, color, tone } = scoreGrade(0);
    return { score: 0, hasData: false, grade, label, color, tone, detail: "", debtCents: 0, benchmarkCents };
  };
  if (profileIds.length === 0) return empty();
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");
  const [acctRow] = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) as n FROM accounts WHERE profile_id IN (${ph}) AND account_type='credit' AND excluded_from_insights=0`,
    [...profileIds]
  );
  if ((acctRow?.n ?? 0) === 0) return empty();

  const now = new Date();
  const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
  // Computed directly (rather than via computeNetWorth) so excluded_from_insights accounts are
  // left out of this score entirely, independent of the hidden_from_dashboard/net-worth flag.
  const creditDebtCents = async (asOfDate?: string): Promise<number> => {
    const dateFilter = asOfDate ? "AND t.date <= ?" : "";
    const params = asOfDate ? [asOfDate, ...profileIds] : [...profileIds];
    const [row] = await db.select<{ total: number | null }[]>(
      `SELECT COALESCE(SUM(bal),0) as total FROM (
         SELECT (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL ${dateFilter}
                 ORDER BY t.date DESC, t.id DESC LIMIT 1) as bal
         FROM accounts a WHERE a.profile_id IN (${ph}) AND a.account_type='credit' AND a.excluded_from_insights=0
       )`,
      params
    );
    return row?.total ?? 0;
  };
  const [debtCents, priorDebtCents] = await Promise.all([
    creditDebtCents(),
    creditDebtCents(monthStart),
  ]);
  const debtAbs = Math.abs(debtCents);

  let score: number;
  if (debtAbs === 0) score = 100;
  else if (debtAbs <= benchmarkCents * 0.25) score = 90;
  else if (debtAbs <= benchmarkCents * 0.5) score = 75;
  else if (debtAbs <= benchmarkCents) score = 55;
  else if (debtAbs <= benchmarkCents * 1.5) score = 35;
  else score = 15;

  // Trend nudge: paid down more than $50 this month -> +10, grew more than $50 -> -10
  const delta = debtCents - priorDebtCents;
  if (delta > 5000) score = Math.min(100, score + 10);
  else if (delta < -5000) score = Math.max(0, score - 10);

  const { grade, label, color, tone } = scoreGrade(score);
  const detail = debtAbs === 0
    ? "No revolving balance, against a national average of about $6,000"
    : `${formatCents(debtAbs)} owed against a national average of about ${formatCents(benchmarkCents)}`;

  return { score, hasData: true, grade, label, color, tone, detail, debtCents, benchmarkCents };
}

// ─── Debt Payoff Plan ──────────────────────────────────────────────────────────
// Feeds the "Debt Payoff" modal (Agent tab) - given one or more debts (loans and/or
// credit cards), simulates three payoff strategies side by side: keep paying minimums
// only, redirect half of discretionary spending, or redirect all of it. Discretionary
// spend is estimated from a fixed set of "cuttable" system categories - these are the
// same kinds of categories flagged as non-essential elsewhere in the app (subscriptions,
// entertainment, shopping, etc.) - averaged over the last 3 months of history.
const DISCRETIONARY_CATEGORY_IDS = [6, 7, 8, 17, 21, 24, 28]; // Entertainment, Shopping,
// Personal Care, Subscriptions, Gifts & Donations, Gambling, Travel

interface DebtPayoffInput {
  id: number;
  balance_cents: number | null;
  interest_rate_bps: number | null;
  minimum_payment_cents: number | null;
}

/** A credit card with no minimum on file defaults to the standard "2% of balance or $25,
 *  whichever is greater" formula most issuers use; a loan with no minimum on file just uses
 *  the same floor as a conservative stand-in until the user records a real payment amount. */
function effectiveMinPaymentCents(balanceCents: number, minimumPaymentCents: number | null): number {
  if (minimumPaymentCents != null && minimumPaymentCents > 0) return minimumPaymentCents;
  return Math.max(2500, Math.round(balanceCents * 0.02));
}

interface SimDebt { id: number; balance: number; monthlyRate: number; minPayment: number; }

/** Month-by-month avalanche/snowball simulation - freed-up minimums roll into the next
 *  priority debt once a debt hits $0 (the standard debt "snowball rolling" behavior), for
 *  whichever `priorityOrder` (list of debt ids) the caller supplies. Returns null months if
 *  minimum payments (plus any extra) never fully pay off every debt within 50 years - i.e. the
 *  payment doesn't outpace interest at that rate. Also returns the month each individual debt
 *  hit $0 (`payoffMonthByDebtId`), used for the payoff timeline visualization. */
function simulateDebtPayoff(debts: SimDebt[], extraMonthlyCents: number, priorityOrder: number[]): {
  months: number | null;
  totalInterestCents: number;
  totalPaidCents: number;
  payoffMonthByDebtId: Record<number, number | null>;
} {
  const MAX_MONTHS = 600; // 50-year safety cap
  const working = debts.map((d) => ({ ...d }));
  const payoffMonthByDebtId: Record<number, number | null> = {};
  for (const d of working) payoffMonthByDebtId[d.id] = d.balance <= 0 ? 0 : null;

  let totalInterest = 0;
  let totalPaid = 0;
  let months = 0;

  while (working.some((d) => d.balance > 0.5) && months < MAX_MONTHS) {
    months++;
    for (const d of working) {
      if (d.balance <= 0) continue;
      const interest = d.balance * d.monthlyRate;
      d.balance += interest;
      totalInterest += interest;
    }
    for (const d of working) {
      if (d.balance <= 0) continue;
      const pay = Math.min(d.minPayment, d.balance);
      d.balance -= pay;
      totalPaid += pay;
    }
    // Minimums freed up by debts that just hit $0 roll into this month's extra pool too.
    const freedMinimums = working.filter((d) => d.balance <= 0).reduce((s, d) => s + d.minPayment, 0);
    let pool = extraMonthlyCents + freedMinimums;
    for (const id of priorityOrder) {
      if (pool <= 0) break;
      const d = working.find((x) => x.id === id)!;
      if (d.balance <= 0) continue;
      const pay = Math.min(pool, d.balance);
      d.balance -= pay;
      totalPaid += pay;
      pool -= pay;
    }
    for (const d of working) {
      if (d.balance <= 0 && payoffMonthByDebtId[d.id] === null) payoffMonthByDebtId[d.id] = months;
    }
  }

  const solved = working.every((d) => d.balance <= 0);
  return {
    months: solved ? months : null,
    totalInterestCents: Math.round(totalInterest),
    totalPaidCents: Math.round(totalPaid),
    payoffMonthByDebtId,
  };
}

function payoffDateFromMonths(months: number | null): string | null {
  if (months == null) return null;
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** Runs one payoff scenario for an arbitrary extra monthly payment amount (e.g. from the Debt
 *  Payoff modal's live slider + category toggles) - pure and synchronous, so the UI can call
 *  this on every interaction with no debounce/DB round-trip needed. `strategy` picks which debt
 *  gets extra payments first: "avalanche" (highest interest rate - saves the most money) or
 *  "snowball" (smallest balance - closes an account soonest, for the Debt Payoff modal's
 *  "quick win" comparison). */
export function simulateCustomDebtPayoff(
  simDebts: DebtPayoffSimDebt[],
  extraMonthlyCents: number,
  strategy: "avalanche" | "snowball" = "avalanche"
): DebtPayoffCustomResult {
  const working: SimDebt[] = simDebts.map((d) => ({
    id: d.id,
    balance: d.balanceCents,
    monthlyRate: d.monthlyRate,
    minPayment: d.minPaymentCents,
  }));
  const priorityOrder = strategy === "snowball"
    ? [...working].sort((a, b) => a.balance - b.balance || b.monthlyRate - a.monthlyRate).map((d) => d.id)
    : [...working].sort((a, b) => b.monthlyRate - a.monthlyRate || a.balance - b.balance).map((d) => d.id);

  const { months, totalInterestCents, totalPaidCents, payoffMonthByDebtId } =
    simulateDebtPayoff(working, extraMonthlyCents, priorityOrder);

  return {
    extraMonthlyCents,
    monthsToPayoff: months,
    payoffDate: payoffDateFromMonths(months),
    totalInterestCents,
    totalPaidCents,
    perDebtMonths: simDebts.map((d) => ({ id: d.id, monthsToPayoff: payoffMonthByDebtId[d.id] ?? null })),
  };
}

/** Builds the three-scenario debt payoff plan (minimum / balanced / aggressive) for a given
 *  set of debts (loans and/or credit cards, one or many). Called both for the combined "all
 *  debts" plan (Credit Card Health card) and a single-account plan (clicking one row on the
 *  Debt Payoff Dashboard) - the caller decides scope by which debts it passes in. */
export async function computeDebtPayoffPlan(profileIds: number[], debts: DebtPayoffInput[]): Promise<DebtPayoffPlan> {
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");

  const totalDebtCents = debts.reduce((s, d) => s + Math.abs(d.balance_cents ?? 0), 0);

  const withRate = debts.filter((d) => d.interest_rate_bps != null && (d.balance_cents ?? 0) !== 0);
  const ratedBalanceTotal = withRate.reduce((s, d) => s + Math.abs(d.balance_cents ?? 0), 0);
  const weightedAvgRateBps = ratedBalanceTotal > 0
    ? Math.round(withRate.reduce((s, d) => s + Math.abs(d.balance_cents ?? 0) * d.interest_rate_bps!, 0) / ratedBalanceTotal)
    : null;
  const hasRateData = withRate.length > 0;

  const simDebts: SimDebt[] = debts
    .filter((d) => (d.balance_cents ?? 0) !== 0)
    .map((d) => {
      const balance = Math.abs(d.balance_cents ?? 0);
      const rateBps = d.interest_rate_bps ?? weightedAvgRateBps ?? 0;
      return {
        id: d.id,
        balance,
        monthlyRate: rateBps / 120000, // bps -> annual fraction (÷10000) -> monthly (÷12)
        minPayment: effectiveMinPaymentCents(balance, d.minimum_payment_cents),
      };
    });
  const totalMinPaymentCents = simDebts.reduce((s, d) => s + d.minPayment, 0);

  // ── Discretionary spending: average over the last 3 full months (excluding the current
  //    partial month), so a mid-month snapshot doesn't understate a category's true average.
  //    Restricted to checking/savings accounts only (account_type NOT IN ('credit','loan')) -
  //    money already spent ON a credit card or loan isn't cash sitting around that can be
  //    "redirected" to pay down debt; counting it would double-count the same dollars as both
  //    a debt balance to pay off AND a source of extra payment toward that debt.
  const now = new Date();
  const threeAgo = toISODate(new Date(now.getFullYear(), now.getMonth() - 3, 1));
  const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));

  const [monthsRow] = await db.select<{ n: number }[]>(
    `SELECT COUNT(DISTINCT strftime('%Y-%m', t.date)) as n FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND a.account_type NOT IN ('credit','loan')`,
    [...profileIds, threeAgo, monthStart]
  );
  const monthsOfHistory = Math.max(1, monthsRow?.n ?? 1);

  const discRows = await db.select<{ category_id: number; name: string; color: string; total: number }[]>(
    `SELECT t.category_id, c.name, c.color, SUM(ABS(t.amount_cents)) as total
     FROM transactions t JOIN categories c ON t.category_id=c.id
     JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.amount_cents<0 AND t.date>=? AND t.date<?
       AND a.account_type NOT IN ('credit','loan')
       AND t.category_id IN (${DISCRETIONARY_CATEGORY_IDS.join(",")})
     GROUP BY t.category_id
     ORDER BY total DESC`,
    [...profileIds, threeAgo, monthStart]
  );

  // Top example descriptions per category (most frequent first), so hovering "Shopping" shows
  // e.g. "Amazon, Target" instead of just an abstract category label.
  const exampleRows = await db.select<{ category_id: number; description: string; cnt: number }[]>(
    `SELECT t.category_id, t.description, COUNT(*) as cnt
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.amount_cents<0 AND t.date>=? AND t.date<?
       AND a.account_type NOT IN ('credit','loan')
       AND t.category_id IN (${DISCRETIONARY_CATEGORY_IDS.join(",")})
       AND t.description<>''
     GROUP BY t.category_id, t.description
     ORDER BY t.category_id, cnt DESC`,
    [...profileIds, threeAgo, monthStart]
  );
  const exampleItemsByCategory = new Map<number, string[]>();
  for (const r of exampleRows) {
    const existing = exampleItemsByCategory.get(r.category_id) ?? [];
    if (existing.length < 3) {
      existing.push(r.description);
      exampleItemsByCategory.set(r.category_id, existing);
    }
  }

  const discretionaryBreakdown: DebtPayoffCategoryBreakdown[] = discRows.map((r) => ({
    categoryId: r.category_id,
    name: r.name,
    color: r.color,
    avgMonthlyCents: Math.round(r.total / monthsOfHistory),
    exampleItems: exampleItemsByCategory.get(r.category_id) ?? [],
  }));

  // ── Truly free money: the same maths as the Insights instrument. Income (the user's Plan
  //    schedule when one exists, else averaged deposits) minus committed bills/recurring minus
  //    normal flexible spending - what is actually available before cutting anything.
  const ff = await getFixedFlexibleInputs(profileIds);
  const ffMonths = monthsWithIncome(ff.txns, ff.candidateMonths);
  const ffSummary = summarizeFixedFlexible(ff.txns, ff.bills, ff.detected, ffMonths, {
    incomeCents: ff.plannedIncomeCents,
    billsCents: ff.plannedBillsCents,
  });
  const freeCash = ffSummary && ffSummary.avgIncomeCents > 0
    ? {
        cents: ffSummary.avgLeftCents,
        incomeBasis: ffSummary.incomeBasis,
        incomeCents: ffSummary.avgIncomeCents,
        committedCents: ffSummary.avgBillsCents + ffSummary.avgRecurringCents,
        // Kept arithmetically consistent with `cents` (income - committed - flexible), so the
        // modal's derivation line always sums; the dedup happens inside the summary.
        flexibleCents: Math.max(0, ffSummary.avgIncomeCents - (ffSummary.avgBillsCents + ffSummary.avgRecurringCents) - ffSummary.avgLeftCents),
        monthsAveraged: ffMonths.length,
      }
    : null;

  const simDebtsPublic: DebtPayoffSimDebt[] = simDebts.map((d) => ({
    id: d.id,
    balanceCents: d.balance,
    monthlyRate: d.monthlyRate,
    minPaymentCents: d.minPayment,
  }));
  const baseline = simulateCustomDebtPayoff(simDebtsPublic, 0, "avalanche");

  return {
    totalDebtCents,
    weightedAvgRateBps,
    hasRateData,
    totalMinPaymentCents,
    discretionaryBreakdown,
    freeCash,
    simDebts: simDebtsPublic,
    baseline,
  };
}
