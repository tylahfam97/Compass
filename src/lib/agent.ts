import { getDb } from "./db";
import type { Insight } from "./types";

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

export async function generateInsights(profileId: number): Promise<Insight[]> {
  const db = await getDb();
  const insights: Insight[] = [];

  // ── 0. Current account balance ───────────────────────────────────────────
  const [balanceRow] = await db.select<{ balance_cents: number; date: string }[]>(
    `SELECT balance_cents, date FROM transactions
     WHERE profile_id=? AND balance_cents IS NOT NULL
     ORDER BY date DESC, id DESC LIMIT 1`,
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
    `SELECT strftime('%Y-%m', date) as month,
            SUM(CASE WHEN amount_cents>0 AND (category_id IS NULL OR category_id!=20) THEN amount_cents ELSE 0 END) as income,
            SUM(CASE WHEN amount_cents<0 AND (category_id IS NULL OR category_id!=20) THEN ABS(amount_cents) ELSE 0 END) as expenses
     FROM transactions WHERE profile_id=? GROUP BY month ORDER BY month DESC LIMIT 12`,
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
      });
    }
  }

  // ── INSIGHT: positive_streak ─────────────────────────────────────────────
  if (monthCount >= 3) {
    const underBudgetBudgets = await db.select<{
      category_id: number;
      category_name: string;
      under_count: number;
    }[]>(
      `SELECT b.category_id, c.name as category_name, COUNT(*) as under_count
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

  // ── Sort: warnings → info → success ─────────────────────────────────────
  const order = { warning: 0, info: 1, success: 2 };
  return insights.sort((a, b) => order[a.severity] - order[b.severity]);
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

export async function getSpendingProfile(profileId: number): Promise<SpendingProfile | null> {
  const db = await getDb();
  const [dataRange] = await db.select<{ months: number }[]>(
    "SELECT COUNT(DISTINCT strftime('%Y-%m', date)) as months FROM transactions WHERE profile_id=?",
    [profileId]
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
       SELECT SUM(CASE WHEN amount_cents>0 THEN amount_cents ELSE 0 END) as income,
              SUM(CASE WHEN amount_cents<0 THEN ABS(amount_cents) ELSE 0 END) as expenses
       FROM transactions WHERE profile_id=? AND date>=?
       GROUP BY strftime('%Y-%m', date)
     )`,
    [profileId, startDate]
  );

  const [topCat] = await db.select<{ name: string; avg_spend: number }[]>(
    `SELECT c.name, CAST(AVG(monthly_spend) AS INTEGER) as avg_spend
     FROM (
       SELECT category_id, SUM(ABS(amount_cents)) as monthly_spend
       FROM transactions WHERE profile_id=? AND amount_cents<0 AND date>=?
       GROUP BY category_id, strftime('%Y-%m', date)
     ) t JOIN categories c ON t.category_id=c.id
     WHERE c.id != 15
     GROUP BY t.category_id ORDER BY avg_spend DESC LIMIT 1`,
    [profileId, startDate]
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
  profileId: number,
  months = 12
): Promise<{ month: string; rate: number; net: number }[]> {
  const db = await getDb();
  const startDate = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - (months - 1));
    d.setDate(1);
    return d.toISOString().split("T")[0];
  })();
  const rows = await db.select<{ month: string; income: number; expenses: number }[]>(
    `SELECT strftime('%Y-%m', date) as month,
            SUM(CASE WHEN amount_cents>0 THEN amount_cents ELSE 0 END) as income,
            SUM(CASE WHEN amount_cents<0 THEN ABS(amount_cents) ELSE 0 END) as expenses
     FROM transactions WHERE profile_id=? AND date>=?
     GROUP BY month ORDER BY month`,
    [profileId, startDate]
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
