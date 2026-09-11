import { getDb, getCreditAccountsForProfile, getLoanAccountsForProfile } from "./db";
import { loadScenario } from "./planScenario";
import { isInterestCharge, type BalancePoint, type CostOfMoneyInputs, type DebtAccount } from "./costOfMoney";
import { averageDailyBalance } from "./costOfMoney";

/**
 * Rows for the Cost of money instrument, summed across the given profiles for one complete
 * month: interest lines on cards and bank accounts, dividend and interest rows from brokerage
 * statements, every card and loan with its balance and APR, and the checking balance history
 * the idle-cash figure averages over. The Plan reserve is read per profile and added up.
 */
export async function getCostOfMoneyInputs(profileIds: number[], month: string, assumedYieldBps: number): Promise<CostOfMoneyInputs> {
  const db = await getDb();
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const next = new Date(y, m, 1);
  const end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
  const ph = profileIds.map(() => "?").join(",");

  const [cardRows, bankRows, investmentRows, balanceRows, ...debtLists] = await Promise.all([
    db.select<{ account_id: number; amount_cents: number; description: string }[]>(
      `SELECT t.account_id, t.amount_cents, t.description FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id IN (${ph}) AND a.account_type='credit' AND a.excluded_from_insights=0
         AND t.amount_cents<0 AND t.date>=? AND t.date<?
         AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
         AND (UPPER(t.description) LIKE '%INTEREST%' OR UPPER(t.description) LIKE '%FINANCE CHARGE%')`,
      [...profileIds, start, end]
    ),
    db.select<{ amount_cents: number; description: string }[]>(
      `SELECT t.amount_cents, t.description FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id IN (${ph}) AND a.account_type='checking' AND a.excluded_from_insights=0
         AND t.amount_cents>0 AND t.date>=? AND t.date<?
         AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
         AND UPPER(t.description) LIKE '%INTEREST%'`,
      [...profileIds, start, end]
    ),
    db.select<{ total: number | null }[]>(
      `SELECT SUM(ABS(amount_cents)) as total FROM investment_activity
       WHERE profile_id IN (${ph}) AND activity_type IN ('dividend','interest') AND trade_date>=? AND trade_date<?`,
      [...profileIds, start, end]
    ),
    db.select<BalancePoint[]>(
      `SELECT t.account_id, t.date, t.balance_cents FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id IN (${ph}) AND a.account_type='checking' AND a.excluded_from_insights=0 AND a.hidden_from_dashboard=0
         AND t.balance_cents IS NOT NULL
       ORDER BY t.date ASC, t.id ASC`,
      [...profileIds]
    ),
    ...profileIds.map((id) => Promise.all([getCreditAccountsForProfile(id), getLoanAccountsForProfile(id)])),
  ]);

  const cardInterest = new Map<number, number>();
  for (const r of cardRows) {
    if (!isInterestCharge(r.description)) continue;
    cardInterest.set(r.account_id, (cardInterest.get(r.account_id) ?? 0) - r.amount_cents);
  }
  const bankInterestCents = bankRows.filter((r) => isInterestCharge(r.description)).reduce((s, r) => s + r.amount_cents, 0);

  const debts: DebtAccount[] = [];
  for (const [cards, loans] of debtLists as [Awaited<ReturnType<typeof getCreditAccountsForProfile>>, Awaited<ReturnType<typeof getLoanAccountsForProfile>>][]) {
    for (const c of cards) if (!c.hidden_from_dashboard) debts.push({ id: c.id, name: c.name, kind: "credit", balanceCents: c.balance_cents, rateBps: c.interest_rate_bps });
    for (const l of loans) if (!l.hidden_from_dashboard) debts.push({ id: l.id, name: l.name, kind: "loan", balanceCents: l.balance_cents, rateBps: l.interest_rate_bps });
  }

  // Latest balance per checking account, from the same history the average is read from.
  const latest = new Map<number, number>();
  for (const p of balanceRows) latest.set(p.account_id, p.balance_cents);
  let latestCheckingCents = 0;
  for (const v of latest.values()) latestCheckingCents += v;

  const reserveCents = profileIds.reduce((s, id) => s + loadScenario(id).buffer, 0);

  return {
    month,
    cardInterest: [...cardInterest.entries()].map(([accountId, cents]) => ({ accountId, cents })),
    bankInterestCents,
    investmentIncomeCents: investmentRows[0]?.total ?? 0,
    debts,
    avgCheckingCents: averageDailyBalance(balanceRows.filter((p) => p.date < end), month),
    latestCheckingCents,
    reserveCents,
    assumedYieldBps,
  };
}
