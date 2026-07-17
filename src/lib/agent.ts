import { getDb } from "./db";
import type { Insight, HealthScore, CreditCardHealthScore } from "./types";
import { computeNetWorth } from "./netWorth";
import { AVG_US_CREDIT_CARD_DEBT_CENTS, scoreGrade } from "./benchmarks";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

/** Returns the N most recent "YYYY-MM" month strings (newest first) */
function recentMonths(n: number): string[] {
  const months: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    months.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    );
    d.setMonth(d.getMonth() - 1);
  }
  return months;
}

// ─── Main analysis function ───────────────────────────────────────────────────

async function _insightsForProfile(profileId: number): Promise<Insight[]> {
  const db = await getDb();
  const insights: Insight[] = [];

  // ── 0. Current account balance (liquid cash only - checking, not credit) ──
  const [balanceRow] = await db.select<{ balance_cents: number; date: string }[]>(
    `SELECT t.balance_cents, t.date FROM transactions t
     JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND t.balance_cents IS NOT NULL AND a.account_type='checking'
     ORDER BY t.date DESC, t.id DESC LIMIT 1`,
    [profileId]
  );
  // balanceRow is available for insight logic below

  // ── 1. How many months of data do we have? ──────────────────────────────
  const [dataRange] = await db.select<{ months: number }[]>(
    `SELECT COUNT(DISTINCT strftime('%Y-%m', date)) as months
     FROM transactions WHERE profile_id=?`,
    [profileId]
  );
  const monthCount = dataRange?.months ?? 0;
  if (monthCount < 1) return []; // nothing to analyse

  const months12 = recentMonths(12);
  const months6 = months12.slice(0, 6);
  const thisMonth = months12[0];
  const [thisStart, thisEnd] = monthBounds(thisMonth);

  // ── 2. Per-month summaries ───────────────────────────────────────────────
  const monthlySummaries = await db.select<{
    month: string;
    income: number;
    expenses: number;
  }[]>(
    `SELECT strftime('%Y-%m', t.date) as month,
            SUM(CASE WHEN t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type!='credit' THEN t.amount_cents ELSE 0 END) as income,
            SUM(CASE WHEN t.amount_cents<0 AND (t.category_id IS NULL OR t.category_id!=20) THEN ABS(t.amount_cents) ELSE 0 END) as expenses
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? GROUP BY month ORDER BY month DESC LIMIT 12`,
    [profileId]
  );

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

  // ── 4. Category averages over last 6 months ─────────────────────────────
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
       SELECT category_id, strftime('%Y-%m', date) as month, SUM(ABS(amount_cents)) as monthly_total
       FROM transactions
       WHERE profile_id=? AND amount_cents<0
         AND (category_id IS NULL OR category_id != 20)
         AND date >= ?
       GROUP BY category_id, month
     ) t
     JOIN categories c ON t.category_id=c.id
     WHERE c.id != 15
     GROUP BY t.category_id
     HAVING month_count >= 2`,
    [profileId, monthBounds(months6[months6.length - 1])[0]]
  );

  // ── 5. This month's category spend ──────────────────────────────────────
  const thisMonthCats = await db.select<{
    category_id: number;
    total: number;
  }[]>(
    `SELECT category_id, SUM(ABS(amount_cents)) as total
     FROM transactions WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0
       AND (category_id IS NULL OR category_id != 20)
     GROUP BY category_id`,
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
        description: `You average ${formatCents(cat.avg_monthly)}/mo on ${cat.category_name} but have no budget set.`,
        severity: "info",
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
          potentialLabel: `Track ${formatCents(cat.avg_monthly)}/mo → stay in control of ${cat.category_name}`,
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
        description: `This month: ${formatCents(thisMonthSpend)} vs avg ${formatCents(cat.avg_monthly)}/mo — ${Math.round((thisMonthSpend / cat.avg_monthly) * 100)}% above normal.`,
        severity: "warning",
        dismissKey: `unusual_spike_${cat.category_id}_${thisMonth}`,
      });
    }
  }

  // ── INSIGHT: savings_rate_low ────────────────────────────────────────────
  if (monthCount >= 2) {
    const recentSummaries = monthlySummaries.slice(0, Math.min(3, monthCount));
    const lowSavingsMonths = recentSummaries.filter((s) => {
      if (s.income === 0) return false;
      return (s.income - s.expenses) / s.income < 0.2;
    });
    if (lowSavingsMonths.length >= 2) {
      const avgRate = recentSummaries.reduce((sum, s) => {
        if (s.income === 0) return sum;
        return sum + (s.income - s.expenses) / s.income;
      }, 0) / recentSummaries.length;
      const avgIncome = recentSummaries.reduce((s, r) => s + r.income, 0) / recentSummaries.length;
      const suggestedSavings = Math.round(avgIncome * 0.2);
      const avgExpenses = recentSummaries.reduce((s, r) => s + r.expenses, 0) / recentSummaries.length;
      const cutPct = avgExpenses > avgIncome * 0.8
        ? Math.round(((avgExpenses - avgIncome * 0.8) / avgExpenses) * 100) : 0;
      insights.push({
        id: "savings_rate_low",
        type: "savings_rate_low",
        title: "Savings rate below 20%",
        description: `Your recent savings rate is ${Math.round(avgRate * 100)}%. A savings goal could help you stay on track.`,
        severity: "warning",
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
          potentialLabel: cutPct > 0
            ? `Cut expenses by ${cutPct}% → savings rate reaches 20%`
            : undefined,
          potentialValue: cutPct > 0 ? cutPct : undefined,
        },
      });
    }
  }

  // ── INSIGHT: overspend_streak ────────────────────────────────────────────
  if (monthCount >= 2) {
    const budgetStreaks = await db.select<{
      category_id: number;
      category_name: string;
      over_count: number;
      budget_cents: number;
    }[]>(
      `SELECT b.category_id, c.name as category_name, b.amount_cents as budget_cents,
              COUNT(*) as over_count
       FROM budgets b
       JOIN categories c ON b.category_id=c.id
       JOIN (
         SELECT category_id, strftime('%Y-%m', date) as month, SUM(ABS(amount_cents)) as spent
         FROM transactions WHERE profile_id=? AND amount_cents<0
         GROUP BY category_id, month
       ) t ON t.category_id=b.category_id AND t.spent > b.amount_cents
       WHERE b.profile_id=?
       GROUP BY b.id HAVING over_count >= 2`,
      [profileId, profileId]
    );
    for (const row of budgetStreaks) {
      insights.push({
        id: `overspend_streak_${row.category_id}`,
        type: "overspend_streak",
        title: `Consistently over budget: ${row.category_name}`,
        description: `You've exceeded this budget ${row.over_count} months in a row. Consider adjusting the limit.`,
        severity: "warning",
        dismissKey: `overspend_streak_${row.category_id}`,
        richData: {
          budgetAmountCents: row.budget_cents,
          overCount: row.over_count,
          potentialLabel: `Staying under → ${formatCents(row.budget_cents)}/mo limit fully tracked`,
        },
      });
    }
  }

  // ── INSIGHT: positive_streak ─────────────────────────────────────────────
  if (monthCount >= 3) {
    const underBudgetBudgets = await db.select<{
      category_id: number;
      category_name: string;
      under_count: number;
      budget_cents: number;
    }[]>(
      `SELECT b.category_id, c.name as category_name, COUNT(*) as under_count, b.amount_cents as budget_cents
       FROM budgets b
       JOIN categories c ON b.category_id=c.id
       JOIN (
         SELECT category_id, strftime('%Y-%m', date) as month, SUM(ABS(amount_cents)) as spent
         FROM transactions WHERE profile_id=? AND amount_cents<0
         GROUP BY category_id, month
       ) t ON t.category_id=b.category_id AND t.spent <= b.amount_cents
       WHERE b.profile_id=?
       GROUP BY b.id HAVING under_count >= 3`,
      [profileId, profileId]
    );
    for (const row of underBudgetBudgets) {
      insights.push({
        id: `positive_streak_${row.category_id}`,
        type: "positive_streak",
        title: `Under budget on ${row.category_name} — ${row.under_count} months running`,
        description: `Great discipline. Consider tightening the limit slightly to lock in more savings.`,
        severity: "success",
        dismissKey: `positive_streak_${row.category_id}`,
        richData: {
          streakMonths: row.under_count,
          budgetAmountCents: row.budget_cents,
          potentialLabel: row.budget_cents > 0
            ? `Tighten by 10% → save ~${formatCents(Math.round(row.budget_cents * 0.1 * 12))}/yr`
            : undefined,
          potentialValue: row.budget_cents > 0 ? Math.round(row.budget_cents * 0.1 * 12) : undefined,
        },
      });
    }
  }

  // ── INSIGHT: ghost_subscription ──────────────────────────────────────────
  const subs = await db.select<{
    description: string;
    amount_cents: number;
    month_count: number;
  }[]>(
    `SELECT description, amount_cents, COUNT(DISTINCT strftime('%Y-%m', date)) as month_count
     FROM transactions WHERE profile_id=? AND amount_cents<0
       AND (category_id IS NULL OR category_id != 20)
     GROUP BY description, amount_cents HAVING month_count>=2
     ORDER BY month_count DESC, ABS(amount_cents) DESC LIMIT 5`,
    [profileId]
  );
  for (const sub of subs) {
    const annualised = Math.abs(sub.amount_cents) * 12;
    insights.push({
      id: `ghost_sub_${sub.description.slice(0, 20)}`,
      type: "ghost_subscription",
      title: `Recurring charge: ${truncate(sub.description, 30)}`,
      description: `${formatCents(Math.abs(sub.amount_cents))}/mo detected ${sub.month_count} times — ${formatCents(annualised)}/year.`,
      severity: "info",
      dismissKey: `ghost_sub_${sub.description.slice(0, 20)}`,
    });
  }

  // ── INSIGHT: redundant_spending ──────────────────────────────────────────
  const sevenDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split("T")[0];
  })();
  const redundant = await db.select<{
    description: string;
    count: number;
    total: number;
  }[]>(
    `SELECT description, COUNT(*) as count, SUM(ABS(amount_cents)) as total
     FROM transactions
     WHERE profile_id=? AND amount_cents<0 AND amount_cents>-1500 AND date>=?
       AND (category_id IS NULL OR category_id != 20)
     GROUP BY description HAVING count>=3
     ORDER BY count DESC LIMIT 3`,
    [profileId, sevenDaysAgo]
  );
  for (const r of redundant) {
    insights.push({
      id: `redundant_${r.description.slice(0, 20)}`,
      type: "redundant_spending",
      title: `Frequent small purchase: ${truncate(r.description, 25)}`,
      description: `${r.count}× in the last 7 days totalling ${formatCents(r.total)}.`,
      severity: "info",
      dismissKey: `redundant_${r.description.slice(0, 20)}`,
    });
  }

  // ── INSIGHT: income_irregular ────────────────────────────────────────────
  if (monthCount >= 3) {
    const incomeMonths = monthlySummaries.slice(0, 3).filter((m) => m.income > 0);
    if (incomeMonths.length >= 3) {
      const avg = incomeMonths.reduce((s, m) => s + m.income, 0) / incomeMonths.length;
      const maxDev = Math.max(...incomeMonths.map((m) => Math.abs(m.income - avg) / avg));
      if (maxDev > 0.4) {
        insights.push({
          id: "income_irregular",
          type: "income_irregular",
          title: "Irregular income detected",
          description: `Your income has varied by up to ${Math.round(maxDev * 100)}% month-to-month. Building a buffer may help.`,
          severity: "info",
          dismissKey: "income_irregular",
        });
      }
    }
  }

  // ── INSIGHT: low balance ────────────────────────────────────────────────
  if (balanceRow?.balance_cents != null) {
    const avgMonthlyExpenses = monthlySummaries.length > 0
      ? monthlySummaries.reduce((s, m) => s + m.expenses, 0) / monthlySummaries.length
      : 0;
    const monthsOfRunway = avgMonthlyExpenses > 0 ? balanceRow.balance_cents / avgMonthlyExpenses : 99;
    if (balanceRow.balance_cents < 50000 && balanceRow.balance_cents >= 0) {
      // Under $500
      insights.push({
        id: "low_balance",
        type: "savings_rate_low",
        title: `Low account balance: ${formatCents(balanceRow.balance_cents)}`,
        description: `Your balance as of ${balanceRow.date} is below $500.${monthsOfRunway < 1 ? " At current spend, this covers less than a month." : ""}`,
        severity: "warning",
        dismissKey: `low_balance_${balanceRow.date}`,
      });
    } else if (monthsOfRunway < 2 && avgMonthlyExpenses > 0) {
      insights.push({
        id: "runway_short",
        type: "savings_rate_low",
        title: "Less than 2 months of expenses in account",
        description: `Balance: ${formatCents(balanceRow.balance_cents)} · avg monthly expenses: ${formatCents(avgMonthlyExpenses)}. Consider building a larger buffer.`,
        severity: "warning",
        dismissKey: `runway_short_${balanceRow.date}`,
      });
    }
  }

  // ── INSIGHT: credit card debt (balance_cents is negative for credit accounts) ──
  const [creditBalanceRow] = await db.select<{ balance_cents: number; date: string }[]>(
    `SELECT t.balance_cents, t.date FROM transactions t
     JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND t.balance_cents IS NOT NULL AND a.account_type='credit'
     ORDER BY t.date DESC, t.id DESC LIMIT 1`,
    [profileId]
  );
  const [creditBalancePriorRow] = await db.select<{ balance_cents: number }[]>(
    `SELECT t.balance_cents FROM transactions t
     JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id=? AND t.balance_cents IS NOT NULL AND a.account_type='credit' AND t.date < ?
     ORDER BY t.date DESC, t.id DESC LIMIT 1`,
    [profileId, thisStart]
  );
  if (creditBalanceRow?.balance_cents != null) {
    const debt = creditBalanceRow.balance_cents; // negative = amount owed
    if (debt < -100000) {
      // Carrying more than $1,000 in credit card debt
      insights.push({
        id: `credit_card_debt_high_${creditBalanceRow.date}`,
        type: "credit_card_debt_high",
        title: `Credit card debt: ${formatCents(Math.abs(debt))}`,
        description: `You're carrying a balance of ${formatCents(Math.abs(debt))} on your credit card as of ${creditBalanceRow.date}. Interest charges add up quickly - paying down high-interest debt is usually a better return than most savings accounts.`,
        severity: "warning",
        dismissKey: `credit_card_debt_high_${creditBalanceRow.date}`,
      });
    }
    if (creditBalancePriorRow?.balance_cents != null) {
      const delta = debt - creditBalancePriorRow.balance_cents; // negative = debt grew
      if (delta < -5000) {
        insights.push({
          id: `credit_card_debt_growing_${thisMonth}`,
          type: "credit_card_debt_growing",
          title: `Credit card debt grew by ${formatCents(Math.abs(delta))}`,
          description: `Your credit card balance went from ${formatCents(Math.abs(creditBalancePriorRow.balance_cents))} to ${formatCents(Math.abs(debt))} owed. Keep an eye on this before it compounds with interest.`,
          severity: "warning",
          dismissKey: `credit_card_debt_growing_${thisMonth}`,
        });
      } else if (delta > 5000) {
        insights.push({
          id: `credit_card_debt_improving_${thisMonth}`,
          type: "credit_card_debt_improving",
          title: `Paid down ${formatCents(delta)} in credit card debt`,
          description: `Nice progress - your credit card balance improved from ${formatCents(Math.abs(creditBalancePriorRow.balance_cents))} to ${formatCents(Math.abs(debt))} owed.`,
          severity: "success",
          dismissKey: `credit_card_debt_improving_${thisMonth}`,
        });
      }
    }
  }

  // ── INSIGHT: top_merchants ───────────────────────────────────────────────
  const topMerchants = await db.select<{ description: string; total: number }[]>(
    `SELECT description, SUM(ABS(amount_cents)) as total
     FROM transactions
     WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0
       AND (category_id IS NULL OR category_id NOT IN (20))
     GROUP BY description ORDER BY total DESC LIMIT 5`,
    [profileId, thisStart, thisEnd]
  );
  if (topMerchants.length >= 3) {
    const lines = topMerchants
      .slice(0, 3)
      .map((m, i) => `${i + 1}. ${truncate(m.description, 28)} — ${formatCents(m.total)}`);
    insights.push({
      id: `top_merchants_${thisMonth}`,
      type: "top_merchants",
      title: "Top spending merchants this month",
      description: lines.join("  ·  "),
      severity: "info",
      dismissKey: `top_merchants_${thisMonth}`,
    });
  }

  // ── INSIGHT: food_delivery_spend ────────────────────────────────────────
  const [deliveryRow] = await db.select<{ total: number }[]>(
    `SELECT COALESCE(SUM(ABS(amount_cents)), 0) as total
     FROM transactions
     WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0
       AND (UPPER(description) LIKE '%DOORDASH%' OR UPPER(description) LIKE '%UBER EATS%'
            OR UPPER(description) LIKE '%GRUBHUB%' OR UPPER(description) LIKE '%INSTACART%')`,
    [profileId, thisStart, thisEnd]
  );
  const deliveryTotal = deliveryRow?.total ?? 0;
  // Sum food-related categories: Food & Dining(3), Groceries(13), Restaurants(14)
  const totalFoodSpend = [3, 13, 14].reduce(
    (s, id) => s + (thisMonthCatMap.get(id) ?? 0),
    0
  );
  if (deliveryTotal > 3000 && totalFoodSpend > 0) {
    const pct = Math.round((deliveryTotal / totalFoodSpend) * 100);
    insights.push({
      id: `food_delivery_${thisMonth}`,
      type: "food_delivery_spend",
      title: `${pct}% of food spending is delivery apps`,
      description: `Food delivery: ${formatCents(deliveryTotal)} · Total food: ${formatCents(totalFoodSpend)} this month. Cooking more could save ${formatCents(Math.round(deliveryTotal * 0.6))}/mo.`,
      severity: pct > 50 ? "warning" : "info",
      dismissKey: `food_delivery_${thisMonth}`,
    });
  }

  // ── INSIGHT: subscription_total ─────────────────────────────────────────
  const subscriptionItems = await db.select<{ description: string; amount_cents: number }[]>(
    `SELECT description, amount_cents
     FROM transactions
     WHERE profile_id=? AND amount_cents<0 AND category_id=17
     GROUP BY description, amount_cents
     ORDER BY ABS(amount_cents) DESC`,
    [profileId]
  );
  if (subscriptionItems.length > 0) {
    const monthlyTotal = subscriptionItems.reduce(
      (s, i) => s + Math.abs(i.amount_cents),
      0
    );
    const preview = subscriptionItems
      .slice(0, 3)
      .map((s) => `${truncate(s.description, 18)} ${formatCents(Math.abs(s.amount_cents))}`)
      .join("  ·  ");
    insights.push({
      id: "subscription_total",
      type: "subscription_total",
      title: `${subscriptionItems.length} subscription${subscriptionItems.length > 1 ? "s" : ""} — ${formatCents(monthlyTotal)}/mo detected`,
      description: preview + (subscriptionItems.length > 3 ? ` + ${subscriptionItems.length - 3} more` : ""),
      severity: "info",
      dismissKey: "subscription_total",
    });
  }

  // ── INSIGHT: income_expected ─────────────────────────────────────────────
  const payrollTxns = await db.select<{ date: string; amount_cents: number }[]>(
    `SELECT date, amount_cents FROM transactions
     WHERE profile_id=? AND amount_cents>50000 AND category_id=1
     ORDER BY date DESC LIMIT 6`,
    [profileId]
  );
  if (payrollTxns.length >= 2) {
    const intervals: number[] = [];
    for (let i = 0; i < payrollTxns.length - 1; i++) {
      const a = new Date(payrollTxns[i].date).getTime();
      const b = new Date(payrollTxns[i + 1].date).getTime();
      const days = Math.round((a - b) / 86_400_000);
      if (days > 0 && days <= 35) intervals.push(days);
    }
    if (intervals.length >= 1) {
      const avgInterval = Math.round(
        intervals.reduce((a, b) => a + b, 0) / intervals.length
      );
      const nextPay = new Date(payrollTxns[0].date);
      nextPay.setDate(nextPay.getDate() + avgInterval);
      const daysUntil = Math.round(
        (nextPay.getTime() - Date.now()) / 86_400_000
      );
      if (daysUntil >= 0 && daysUntil <= 14) {
        insights.push({
          id: `income_expected_${thisMonth}`,
          type: "income_expected",
          title:
            daysUntil === 0
              ? "Paycheck expected today"
              : `Paycheck in ~${daysUntil} day${daysUntil > 1 ? "s" : ""}`,
          description: `Based on your ${avgInterval}-day pay cycle. Last deposit: ${formatCents(Math.abs(payrollTxns[0].amount_cents))} on ${payrollTxns[0].date}.`,
          severity: "info",
          dismissKey: `income_expected_${thisMonth}`,
        });
      }
    }
  }

  // ── INSIGHT: overdraft_alert ────────────────────────────────────────────
  const [overdraftRow] = await db.select<{ count: number; total: number }[]>(
    `SELECT COUNT(*) as count, COALESCE(SUM(ABS(amount_cents)), 0) as total
     FROM transactions
     WHERE profile_id=? AND date>=? AND date<?
       AND (category_id=19 OR UPPER(description) LIKE '%OVERDRAFT FEE%')
       AND amount_cents<0`,
    [profileId, thisStart, thisEnd]
  );
  if (overdraftRow && overdraftRow.count > 0) {
    insights.push({
      id: `overdraft_alert_${thisMonth}`,
      type: "overdraft_alert",
      title: `Bank fees detected this month`,
      description: `${overdraftRow.count} bank fee charge${overdraftRow.count > 1 ? "s" : ""} totaling ${formatCents(overdraftRow.total)}. Keeping a $200–$500 buffer can prevent these.`,
      severity: "warning",
      dismissKey: `overdraft_alert_${thisMonth}`,
    });
  }

  // ── INSIGHT: category_creep ──────────────────────────────────────────────
  // Compare avg spend last 3 months vs months 4-6 for each category.
  if (monthCount >= 6) {
    const recent3Start = monthBounds(months6[2])[0]; // 3 months ago start
    const older3Start  = monthBounds(months6[5])[0]; // 6 months ago start
    const older3End    = monthBounds(months6[2])[0]; // = recent3Start (exclusive)

    const recentAvgs = await db.select<{ category_id: number; category_name: string; avg_spend: number }[]>(
      `SELECT t.category_id, c.name as category_name,
              CAST(AVG(monthly) AS INTEGER) as avg_spend
       FROM (SELECT category_id, strftime('%Y-%m',date) as mo, SUM(ABS(amount_cents)) as monthly
             FROM transactions WHERE profile_id=? AND amount_cents<0 AND date>=?
               AND (category_id IS NULL OR category_id != 20) AND category_id != 15
             GROUP BY category_id, mo) t
       JOIN categories c ON t.category_id=c.id
       GROUP BY t.category_id HAVING COUNT(*)>=2`,
      [profileId, recent3Start]
    );
    const olderAvgs = await db.select<{ category_id: number; avg_spend: number }[]>(
      `SELECT category_id, CAST(AVG(monthly) AS INTEGER) as avg_spend
       FROM (SELECT category_id, strftime('%Y-%m',date) as mo, SUM(ABS(amount_cents)) as monthly
             FROM transactions WHERE profile_id=? AND amount_cents<0 AND date>=? AND date<?
               AND (category_id IS NULL OR category_id != 20)
             GROUP BY category_id, mo) t
       GROUP BY category_id HAVING COUNT(*)>=2`,
      [profileId, older3Start, older3End]
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
          description: `Avg last 3 mo: ${formatCents(r.avg_spend)} vs ${formatCents(older)} before — ${formatCents(deltaAnnual)} more per year if unchecked.`,
          severity: "warning",
          dismissKey: `category_creep_${r.category_id}_${thisMonth}`,
        });
      }
    }
  }

  // ── INSIGHT: year_end_projection ────────────────────────────────────────
  if (monthCount >= 2) {
    const recentNets = monthlySummaries.slice(0, Math.min(3, monthCount));
    const avgNet = recentNets.reduce((s, m) => s + (m.income - m.expenses), 0) / recentNets.length;
    const now = new Date();
    const monthsLeft = 12 - now.getMonth(); // months remaining inc. current
    if (monthsLeft > 0) {
      const projected = Math.round(avgNet * monthsLeft);
      insights.push({
        id: `year_end_projection_${now.getFullYear()}`,
        type: "year_end_projection",
        title: projected >= 0
          ? `On pace to save ${formatCents(projected)} by year-end`
          : `On pace to spend ${formatCents(Math.abs(projected))} more than you earn by year-end`,
        description: `Based on your ${recentNets.length}-month avg net of ${formatCents(avgNet)}/mo · ${monthsLeft} month${monthsLeft > 1 ? "s" : ""} remaining in ${now.getFullYear()}.`,
        severity: projected >= 0 ? "info" : "warning",
        dismissKey: `year_end_projection_${now.getFullYear()}`,
        richData: {
          projectedSavings: projected,
        },
      });
    }
  }

  // ── INSIGHT: most_improved ───────────────────────────────────────────────
  if (monthCount >= 2 && monthlySummaries.length >= 2) {
    const prevMonth = monthlySummaries[1]?.month;
    if (prevMonth) {
      const [prevStart, prevEnd] = monthBounds(prevMonth);
      const prevCats = await db.select<{ category_id: number; total: number }[]>(
        `SELECT category_id, SUM(ABS(amount_cents)) as total
         FROM transactions WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0
           AND (category_id IS NULL OR category_id != 20)
         GROUP BY category_id`,
        [profileId, prevStart, prevEnd]
      );
      const prevMap = new Map(prevCats.map((c) => [c.category_id, c.total]));
      let bestCat: { name: string; pctDrop: number; prevTotal: number; thisTotal: number } | null = null;
      for (const [catId, thisTotal] of thisMonthCatMap) {
        const prev = prevMap.get(catId);
        if (!prev || prev < 5000) continue;
        const pctDrop = Math.round(((prev - thisTotal) / prev) * 100);
        if (pctDrop >= 20 && prev - thisTotal >= 3000) {
          if (!bestCat || pctDrop > bestCat.pctDrop) {
            const catName = catAvgs.find((c) => c.category_id === catId)?.category_name ?? `Category ${catId}`;
            bestCat = { name: catName, pctDrop, prevTotal: prev, thisTotal };
          }
        }
      }
      if (bestCat) {
        insights.push({
          id: `most_improved_${thisMonth}`,
          type: "most_improved",
          title: `Most improved: ${bestCat.name} — down ${bestCat.pctDrop}% vs last month`,
          description: `Last month: ${formatCents(bestCat.prevTotal)} · This month so far: ${formatCents(bestCat.thisTotal)}. Great progress — keep it up.`,
          severity: "success",
          dismissKey: `most_improved_${thisMonth}`,
          richData: {
            beforeAmount: bestCat.prevTotal,
            afterAmount: bestCat.thisTotal,
          },
        });
      }
    }
  }

  // ── INSIGHT: weekend_spending ────────────────────────────────────────────
  // (strftime('%w',date)+6)%7 gives Mon=0..Sun=6; weekend = >= 5
  if (monthCount >= 3) {
    const [weekendRow] = await db.select<{ weekend: number; weekday: number }[]>(
      `SELECT
         SUM(CASE WHEN (CAST(strftime('%w',date) AS INTEGER)+6)%7 >= 5 THEN ABS(amount_cents) ELSE 0 END) as weekend,
         SUM(CASE WHEN (CAST(strftime('%w',date) AS INTEGER)+6)%7 <  5 THEN ABS(amount_cents) ELSE 0 END) as weekday
       FROM transactions
       WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0
         AND (category_id IS NULL OR category_id != 20)`,
      [profileId, thisStart, thisEnd]
    );
    const weekendTotal = weekendRow?.weekend ?? 0;
    const weekdayTotal = weekendRow?.weekday ?? 0;
    const grandTotal = weekendTotal + weekdayTotal;
    if (grandTotal > 10000 && weekendTotal > 0) {
      const weekendPct = Math.round((weekendTotal / grandTotal) * 100);
      if (weekendPct >= 35) {
        // Top weekend merchant
        const [topWeekendMerchant] = await db.select<{ description: string; total: number }[]>(
          `SELECT description, SUM(ABS(amount_cents)) as total
           FROM transactions
           WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0
             AND (CAST(strftime('%w',date) AS INTEGER)+6)%7 >= 5
             AND (category_id IS NULL OR category_id != 20)
           GROUP BY description ORDER BY total DESC LIMIT 1`,
          [profileId, thisStart, thisEnd]
        );
        insights.push({
          id: `weekend_spending_${thisMonth}`,
          type: "weekend_spending",
          title: `${weekendPct}% of spending happens on weekends`,
          description: `Weekends: ${formatCents(weekendTotal)} · Weekdays: ${formatCents(weekdayTotal)} this month.${topWeekendMerchant ? ` Top weekend: ${truncate(topWeekendMerchant.description, 25)}.` : ""}`,
          severity: weekendPct >= 50 ? "warning" : "info",
          dismissKey: `weekend_spending_${thisMonth}`,
        });
      }
    }
  }

  // ── INSIGHT: spending_velocity ────────────────────────────────────────────
  // Are we spending faster than normal so far this month?
  {
    const now = new Date();
    const elapsed = now.getDate(); // days elapsed in current month
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (elapsed >= 5 && monthlySummaries.length >= 2) {
      const [currentSpendRow] = await db.select<{ total: number }[]>(
        `SELECT COALESCE(SUM(ABS(amount_cents)),0) as total
         FROM transactions WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0
           AND (category_id IS NULL OR category_id != 20)`,
        [profileId, thisStart, thisEnd]
      );
      const currentSpend = currentSpendRow?.total ?? 0;
      const avgMonthly = monthlySummaries.slice(1).reduce((s, m) => s + m.expenses, 0)
        / Math.max(monthlySummaries.slice(1).length, 1);
      const pacedMonthly = Math.round((currentSpend / elapsed) * daysInMonth);
      const overshootPct = avgMonthly > 0
        ? Math.round(((pacedMonthly - avgMonthly) / avgMonthly) * 100)
        : 0;
      if (avgMonthly > 5000 && pacedMonthly > avgMonthly * 1.15) {
        const daysLeft = daysInMonth - elapsed;
        insights.push({
          id: `spending_velocity_${thisMonth}`,
          type: "spending_velocity",
          title: `Spending ${overshootPct}% above your normal pace this month`,
          description: `${elapsed} days in: ${formatCents(currentSpend)} spent — on pace for ${formatCents(pacedMonthly)} vs your avg ${formatCents(avgMonthly)}.`,
          severity: overshootPct >= 30 ? "warning" : "info",
          dismissKey: `spending_velocity_${thisMonth}`,
          richData: {
            paceMonthly: pacedMonthly,
            avgMonthly: Math.round(avgMonthly),
            potentialLabel: daysLeft > 0
              ? `Spend ${formatCents(Math.round((pacedMonthly - Math.round(avgMonthly)) / daysLeft))}/day less → finish on track`
              : undefined,
          },
        });
      }
    }
  }

  // ── INSIGHT: emergency_fund_runway ───────────────────────────────────────
  if (balanceRow?.balance_cents != null && balanceRow.balance_cents > 0) {
    const avgExp = monthlySummaries.length > 0
      ? monthlySummaries.reduce((s, m) => s + m.expenses, 0) / monthlySummaries.length
      : 0;
    if (avgExp > 0) {
      const runway = balanceRow.balance_cents / avgExp;
      const runwayStr = runway < 1
        ? `less than 1 month`
        : runway < 6
        ? `~${runway.toFixed(1)} months`
        : `${Math.floor(runway)} months`;
      insights.push({
        id: `emergency_fund_runway_${balanceRow.date}`,
        type: "emergency_fund_runway",
        title: `Your balance covers ${runwayStr} of expenses`,
        description: `Balance: ${formatCents(balanceRow.balance_cents)} · Avg monthly spend: ${formatCents(avgExp)}.${runway < 3 ? " Financial advisors typically recommend 3–6 months." : runway >= 6 ? " You have a healthy emergency cushion." : ""}`,
        severity: runway < 1 ? "warning" : runway < 3 ? "warning" : runway < 6 ? "info" : "success",
        dismissKey: `emergency_fund_runway_${balanceRow.date}`,
        richData: {
          runwayMonths: parseFloat(runway.toFixed(1)),
          potentialLabel: runway < 3
            ? `Save ${formatCents(Math.max(0, Math.round(avgExp * 3 - balanceRow.balance_cents)))} more → reach 3-month runway`
            : undefined,
        },
      });
    }
  }

  // ── INSIGHT: bill_due_soon ────────────────────────────────────────────────
  // Find recurring fixed expenses and predict next occurrence within 7 days
  if (monthCount >= 2) {
    const recurring = await db.select<{
      description: string;
      amount_cents: number;
      last_date: string;
      count: number;
      span_days: number;
    }[]>(
      `SELECT description, amount_cents, MAX(date) as last_date,
              COUNT(*) as count,
              CAST(MAX(julianday(date)) - MIN(julianday(date)) AS INTEGER) as span_days
       FROM transactions
       WHERE profile_id=? AND amount_cents<0 AND amount_cents<-500
         AND (category_id IS NULL OR category_id NOT IN (15, 20))
       GROUP BY description, amount_cents
       HAVING count >= 2 AND span_days >= 10
       ORDER BY ABS(amount_cents) DESC LIMIT 10`,
      [profileId]
    );
    const today = new Date();
    for (const r of recurring) {
      const avgIntervalDays = r.span_days / (r.count - 1);
      if (avgIntervalDays < 5 || avgIntervalDays > 40) continue; // skip daily or very infrequent
      const lastDate = new Date(r.last_date);
      const nextDate = new Date(lastDate);
      nextDate.setDate(lastDate.getDate() + Math.round(avgIntervalDays));
      const daysUntil = Math.round((nextDate.getTime() - today.getTime()) / 86_400_000);
      if (daysUntil >= 0 && daysUntil <= 7) {
        insights.push({
          id: `bill_due_${r.description.slice(0, 20)}_${thisMonth}`,
          type: "bill_due_soon",
          title: daysUntil === 0
            ? `${truncate(r.description, 30)} due today`
            : `${truncate(r.description, 30)} due in ${daysUntil} day${daysUntil > 1 ? "s" : ""}`,
          description: `${formatCents(Math.abs(r.amount_cents))} · Recurs every ~${Math.round(avgIntervalDays)} days based on ${r.count} past charges.`,
          severity: "info",
          dismissKey: `bill_due_${r.description.slice(0, 20)}_${thisMonth}`,
        });
        break; // max 1 bill-due insight to avoid flooding
      }
    }
  }

  // ── INSIGHT: expense_ratio_drift ─────────────────────────────────────────
  // Is the expense/income ratio getting worse over time?
  if (monthCount >= 6) {
    const recent3 = monthlySummaries.slice(0, 3).filter((m) => m.income > 0);
    const older3  = monthlySummaries.slice(3, 6).filter((m) => m.income > 0);
    if (recent3.length >= 2 && older3.length >= 2) {
      const recentRatio = recent3.reduce((s, m) => s + m.expenses / m.income, 0) / recent3.length;
      const olderRatio  = older3.reduce((s, m) => s + m.expenses / m.income, 0) / older3.length;
      const driftPts = Math.round((recentRatio - olderRatio) * 100); // percentage points
      if (driftPts >= 8) {
        const recentSavingsPct = Math.round((1 - recentRatio) * 100);
        insights.push({
          id: `expense_ratio_drift_${thisMonth}`,
          type: "expense_ratio_drift",
          title: `Savings margin compressed by ${driftPts} points over 6 months`,
          description: `Your expenses now take ${Math.round(recentRatio * 100)}% of income (was ${Math.round(olderRatio * 100)}% 3–6 months ago). Current savings rate: ${recentSavingsPct}%.`,
          severity: driftPts >= 15 ? "warning" : "info",
          dismissKey: `expense_ratio_drift_${thisMonth}`,
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
    if (netWorthDelta > 0) {
      insights.push({
        id: `net_worth_growing_${thisMonth}`,
        type: "net_worth_growing",
        title: `Net worth grew by ${formatCents(netWorthDelta)} this month`,
        description: `Your net worth (liquid cash + investments − debt) went from ${formatCents(priorNetWorth.netWorthCents)} to ${formatCents(nowNetWorth.netWorthCents)}.`,
        severity: "success",
        dismissKey: `net_worth_growing_${thisMonth}`,
      });
    } else {
      insights.push({
        id: `net_worth_declining_${thisMonth}`,
        type: "net_worth_declining",
        title: `Net worth dropped by ${formatCents(Math.abs(netWorthDelta))} this month`,
        description: `Your net worth (liquid cash + investments − debt) went from ${formatCents(priorNetWorth.netWorthCents)} to ${formatCents(nowNetWorth.netWorthCents)}.`,
        severity: "warning",
        dismissKey: `net_worth_declining_${thisMonth}`,
      });
    }
  }

  // ── Sort: warnings → info → success ─────────────────────────────────────
  const order = { warning: 0, info: 1, success: 2 };
  return insights.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Public entry-point. Pass one or more profile IDs.
 * In single-profile mode this is a thin pass-through.
 * In multi-profile mode, insights are gathered per-profile and merged/deduped.
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
  const ord = { warning: 0, info: 1, success: 2 };
  return merged.sort((a, b) => ord[a.severity] - ord[b.severity]);
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

  const startDate = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 5);
    d.setDate(1);
    return d.toISOString().split("T")[0];
  })();

  const [summary] = await db.select<{ avg_income: number; avg_expenses: number }[]>(
    `SELECT AVG(income) as avg_income, AVG(expenses) as avg_expenses
     FROM (
       SELECT SUM(CASE WHEN t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type!='credit' THEN t.amount_cents ELSE 0 END) as income,
              SUM(CASE WHEN t.amount_cents<0 AND (t.category_id IS NULL OR t.category_id!=20) THEN ABS(t.amount_cents) ELSE 0 END) as expenses
       FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id IN (${ph}) AND t.date>=?
       GROUP BY strftime('%Y-%m', t.date)
     )`,
    [...profileIds, startDate]
  );

  const [topCat] = await db.select<{ name: string; avg_spend: number }[]>(
    `SELECT c.name, CAST(AVG(monthly_spend) AS INTEGER) as avg_spend
     FROM (
       SELECT category_id, SUM(ABS(amount_cents)) as monthly_spend
       FROM transactions WHERE profile_id IN (${ph}) AND amount_cents<0 AND date>=?
         AND (category_id IS NULL OR category_id!=20)
       GROUP BY category_id, strftime('%Y-%m', date)
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
    topCategory: topCat?.name ?? "—",
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
  const startDate = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - (months - 1));
    d.setDate(1);
    return d.toISOString().split("T")[0];
  })();
  const rows = await db.select<{ month: string; income: number; expenses: number }[]>(
    `SELECT strftime('%Y-%m', t.date) as month,
            SUM(CASE WHEN t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type!='credit' THEN t.amount_cents ELSE 0 END) as income,
            SUM(CASE WHEN t.amount_cents<0 AND (t.category_id IS NULL OR t.category_id!=20) THEN ABS(t.amount_cents) ELSE 0 END) as expenses
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.date>=?
     GROUP BY month ORDER BY month`,
    [...profileIds, startDate]
  );
  return rows.map((r) => ({
    month: r.month,
    net: r.income - r.expenses,
    rate: r.income > 0 ? Math.round(((r.income - r.expenses) / r.income) * 100) : 0,
  }));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ─── Financial Health Score ───────────────────────────────────────────────────

export async function computeHealthScore(profileIds: number[]): Promise<HealthScore> {
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");

  const now = new Date();
  const threeAgo = (() => { const d = new Date(now); d.setMonth(d.getMonth() - 3); d.setDate(1); return d.toISOString().split("T")[0]; })();
  const sixAgo   = (() => { const d = new Date(now); d.setMonth(d.getMonth() - 6); d.setDate(1); return d.toISOString().split("T")[0]; })();
  const msStart  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const msEnd    = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().split("T")[0];

  // ── 1. Savings Rate (40 pts) — 3-month avg ──────────────────────────────
  const srRows = await db.select<{ income: number; expenses: number }[]>(
    `SELECT
       SUM(CASE WHEN t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type!='credit' THEN t.amount_cents ELSE 0 END) as income,
       SUM(CASE WHEN t.amount_cents<0 AND (t.category_id IS NULL OR t.category_id!=20) THEN ABS(t.amount_cents) ELSE 0 END) as expenses
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.date>=?
     GROUP BY strftime('%Y-%m', t.date) LIMIT 3`,
    [...profileIds, threeAgo]
  );
  const validSR = srRows.filter(r => r.income > 0);
  const avgRate = validSR.length > 0
    ? validSR.reduce((s, r) => s + (r.income - r.expenses) / r.income, 0) / validSR.length : 0;
  const savingsScore = avgRate >= 0.20 ? 40 : avgRate >= 0.15 ? 30 : avgRate >= 0.10 ? 20 : avgRate >= 0.05 ? 10 : 0;

  // ── 2. Budget Health (30 pts) — this month ──────────────────────────────
  const budgets = await db.select<{ category_id: number; amount_cents: number }[]>(
    `SELECT category_id, amount_cents FROM budgets WHERE profile_id IN (${ph}) OR is_global=1`,
    [...profileIds]
  );
  let budgetScore = 15;
  if (budgets.length > 0) {
    const spendRows = await db.select<{ category_id: number; spent: number }[]>(
      `SELECT category_id, SUM(ABS(amount_cents)) as spent
       FROM transactions WHERE profile_id IN (${ph}) AND date>=? AND date<? AND amount_cents<0
       GROUP BY category_id`,
      [...profileIds, msStart, msEnd]
    );
    const sm = new Map(spendRows.map(s => [s.category_id, s.spent]));
    const over = budgets.filter(b => (sm.get(b.category_id) ?? 0) > b.amount_cents).length;
    const pct = (budgets.length - over) / budgets.length;
    budgetScore = pct >= 1.0 ? 30 : pct >= 0.8 ? 24 : pct >= 0.6 ? 18 : pct >= 0.4 ? 12 : 6;
  }

  // ── 3. Balance Runway (20 pts) — liquid cash only, not credit card debt ──
  const [balRow] = await db.select<{ balance_cents: number | null }[]>(
    `SELECT t.balance_cents FROM transactions t
     JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.balance_cents IS NOT NULL AND a.account_type='checking'
     ORDER BY t.date DESC, t.id DESC LIMIT 1`,
    [...profileIds]
  );
  let balanceScore = 10;
  if ((balRow?.balance_cents ?? 0) > 0) {
    const [expRow] = await db.select<{ avg_exp: number }[]>(
      `SELECT AVG(me) as avg_exp FROM (
         SELECT SUM(ABS(amount_cents)) as me FROM transactions
         WHERE profile_id IN (${ph}) AND amount_cents<0 AND (category_id IS NULL OR category_id!=20) AND date>=?
         GROUP BY strftime('%Y-%m', date))`,
      [...profileIds, threeAgo]
    );
    const avgExp = expRow?.avg_exp ?? 0;
    if (avgExp > 0) {
      const rw = balRow!.balance_cents! / avgExp;
      balanceScore = rw >= 6 ? 20 : rw >= 3 ? 15 : rw >= 1 ? 8 : 2;
    }
  }

  // ── 4. Income Stability (10 pts) — 6-month variance ───────────────────
  const incRows = await db.select<{ income: number }[]>(
    `SELECT SUM(CASE WHEN t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type!='credit' THEN t.amount_cents ELSE 0 END) as income
     FROM transactions t JOIN accounts a ON a.id=t.account_id
     WHERE t.profile_id IN (${ph}) AND t.date>=?
     GROUP BY strftime('%Y-%m', t.date)`,
    [...profileIds, sixAgo]
  );
  const incomes = incRows.filter(r => r.income > 0).map(r => r.income);
  let incomeScore = 5;
  if (incomes.length >= 2) {
    const avg = incomes.reduce((a, b) => a + b, 0) / incomes.length;
    const maxDev = Math.max(...incomes.map(v => Math.abs(v - avg) / avg));
    incomeScore = maxDev < 0.10 ? 10 : maxDev < 0.25 ? 7 : maxDev < 0.40 ? 4 : 1;
  }

  const total = savingsScore + budgetScore + balanceScore + incomeScore;
  const { grade, label, color } = scoreGrade(total);

  return {
    total, grade, label, color,
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
  if (profileIds.length === 0) {
    return { score: 0, hasData: false, grade: "—", label: "Getting Started", color: "#6b7280", detail: "", debtCents: 0, benchmarkCents };
  }
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");
  const [acctRow] = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) as n FROM accounts WHERE profile_id IN (${ph}) AND account_type='credit'`,
    [...profileIds]
  );
  if ((acctRow?.n ?? 0) === 0) {
    return { score: 0, hasData: false, grade: "—", label: "Getting Started", color: "#6b7280", detail: "", debtCents: 0, benchmarkCents };
  }

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const [current, prior] = await Promise.all([
    computeNetWorth(profileIds),
    computeNetWorth(profileIds, monthStart),
  ]);
  const debtCents = current.debtCents; // <= 0
  const debtAbs = Math.abs(debtCents);

  let score: number;
  if (debtAbs === 0) score = 100;
  else if (debtAbs <= benchmarkCents * 0.25) score = 90;
  else if (debtAbs <= benchmarkCents * 0.5) score = 75;
  else if (debtAbs <= benchmarkCents) score = 55;
  else if (debtAbs <= benchmarkCents * 1.5) score = 35;
  else score = 15;

  // Trend nudge: paid down more than $50 this month -> +10, grew more than $50 -> -10
  const delta = debtCents - prior.debtCents;
  if (delta > 5000) score = Math.min(100, score + 10);
  else if (delta < -5000) score = Math.max(0, score - 10);

  const { grade, label, color } = scoreGrade(score);
  const detail = debtAbs === 0
    ? "No revolving balance - vs the ~$6,000 national average"
    : `${formatCents(debtAbs)} owed vs the ~${formatCents(benchmarkCents)} national average`;

  return { score, hasData: true, grade, label, color, detail, debtCents, benchmarkCents };
}
