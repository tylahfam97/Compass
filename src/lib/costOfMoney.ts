import { daysInMonth } from "./insights/shape";

/**
 * Cost of money: what the household paid to borrow last month against what its money earned,
 * and what today's balances are accruing right now. Pure; costOfMoneyData.ts gathers the rows.
 *
 * Card interest is read from the interest lines on card statements (the same match the
 * `interest_paid` insight uses). Loan interest is estimated from the balance and APR on file,
 * because loan statements arrive as one snapshot row. Interest earned is read from interest
 * lines on bank accounts and from dividend and interest rows on brokerage statements. The yield
 * forgone on idle checking is an assumption the user can edit, never a measurement.
 */

export const INTEREST_RE = /INTEREST|FINANCE CHARGE/i;
export const NOT_INTEREST_RE = /INTEREST FREE|REVERSAL|REFUND/i;

/** Top online savings APY in September 2026, as a starting assumption; the instrument lets the
 *  user change it and remembers the choice. */
export const DEFAULT_ASSUMED_YIELD_BPS = 420;
export const ASSUMED_YIELD_KEY = "compass_assumed_yield_bps";

export function isInterestCharge(description: string): boolean {
  return INTEREST_RE.test(description) && !NOT_INTEREST_RE.test(description);
}

export interface BalancePoint {
  account_id: number;
  date: string;
  balance_cents: number;
}

/**
 * Average of the combined balance over every day of `month`, carrying each account's last known
 * balance forward. Rows dated before the month set each account's opening balance; an account
 * with no balance on record yet counts as zero until its first one.
 */
export function averageDailyBalance(points: BalancePoint[], month: string): number {
  const days = daysInMonth(month);
  const sorted = points.slice().sort((a, b) => a.date.localeCompare(b.date));
  const last = new Map<number, number>();
  const start = `${month}-01`;
  let i = 0;
  while (i < sorted.length && sorted[i].date < start) { last.set(sorted[i].account_id, sorted[i].balance_cents); i++; }
  let sum = 0;
  for (let d = 1; d <= days; d++) {
    const iso = `${month}-${String(d).padStart(2, "0")}`;
    while (i < sorted.length && sorted[i].date <= iso) { last.set(sorted[i].account_id, sorted[i].balance_cents); i++; }
    let total = 0;
    for (const v of last.values()) total += v;
    sum += total;
  }
  return Math.round(sum / days);
}

export interface DebtAccount {
  id: number;
  name: string;
  kind: "credit" | "loan";
  /** Stored negative (a liability), or null when no statement has a balance yet. */
  balanceCents: number | null;
  rateBps: number | null;
}

export interface CostOfMoneyInputs {
  /** The complete month measured, YYYY-MM. */
  month: string;
  /** Interest actually charged per card in the month, as positive cents. */
  cardInterest: { accountId: number; cents: number }[];
  bankInterestCents: number;
  investmentIncomeCents: number;
  debts: DebtAccount[];
  avgCheckingCents: number;
  latestCheckingCents: number;
  /** The Plan reserve: cash meant to sit still, so it is never counted as idle. */
  reserveCents: number;
  assumedYieldBps: number;
}

export interface DebtCost {
  id: number;
  name: string;
  kind: "credit" | "loan";
  balanceCents: number;
  rateBps: number | null;
  /** Interest read from the month's statement lines (cards only). */
  measuredCents: number;
  /** Today's accrual in cents, fractional. */
  dailyCents: number;
  basis: "measured" | "estimated" | "none";
}

export interface CostOfMoneySummary {
  month: string;
  days: number;
  paidCardCents: number;
  paidLoanCents: number;
  paidCents: number;
  earnedBankCents: number;
  earnedInvestmentCents: number;
  earnedCents: number;
  /** Earned minus paid: negative when money cost more than it made. */
  netCents: number;
  idleCents: number;
  forgoneCents: number;
  dailyCostCents: number;
  dailyEarnCents: number;
  dailyForgoneCents: number;
  perAccount: DebtCost[];
  missingRate: string[];
  assumedYieldBps: number;
  reserveCents: number;
}

export function summarizeCostOfMoney(input: CostOfMoneyInputs): CostOfMoneySummary {
  const days = daysInMonth(input.month);
  const measured = new Map(input.cardInterest.map((c) => [c.accountId, c.cents]));
  const perAccount: DebtCost[] = [];
  const missingRate: string[] = [];
  let paidCard = 0;
  let paidLoan = 0;
  let dailyCost = 0;

  for (const d of input.debts) {
    const balance = Math.abs(d.balanceCents ?? 0);
    const m = measured.get(d.id) ?? 0;
    let daily = 0;
    let basis: DebtCost["basis"] = "none";
    if (d.kind === "credit") {
      paidCard += m;
      // A card only accrues when it was actually charged interest; a card paid in full costs nothing
      // however large its statement balance.
      if (m > 0) {
        if (d.rateBps != null && balance > 0) { daily = (balance * d.rateBps) / 10_000 / 365; basis = "estimated"; }
        else { daily = m / days; basis = "measured"; }
      }
    } else if (balance > 0) {
      if (d.rateBps != null) {
        paidLoan += (balance * d.rateBps) / 10_000 / 12;
        daily = (balance * d.rateBps) / 10_000 / 365;
        basis = "estimated";
      } else {
        missingRate.push(d.name);
      }
    }
    dailyCost += daily;
    perAccount.push({ id: d.id, name: d.name, kind: d.kind, balanceCents: balance, rateBps: d.rateBps, measuredCents: m, dailyCents: daily, basis });
  }
  perAccount.sort((a, b) => b.dailyCents - a.dailyCents || b.measuredCents - a.measuredCents || a.name.localeCompare(b.name));

  const paidLoanCents = Math.round(paidLoan);
  const earnedCents = input.bankInterestCents + input.investmentIncomeCents;
  const paidCents = paidCard + paidLoanCents;
  const idleCents = Math.max(0, input.avgCheckingCents - input.reserveCents);
  const idleNow = Math.max(0, input.latestCheckingCents - input.reserveCents);

  return {
    month: input.month,
    days,
    paidCardCents: paidCard,
    paidLoanCents,
    paidCents,
    earnedBankCents: input.bankInterestCents,
    earnedInvestmentCents: input.investmentIncomeCents,
    earnedCents,
    netCents: earnedCents - paidCents,
    idleCents,
    forgoneCents: Math.round((idleCents * input.assumedYieldBps) / 10_000 / 12),
    dailyCostCents: dailyCost,
    dailyEarnCents: earnedCents / days,
    dailyForgoneCents: (idleNow * input.assumedYieldBps) / 10_000 / 365,
    perAccount,
    missingRate,
    assumedYieldBps: input.assumedYieldBps,
    reserveCents: input.reserveCents,
  };
}

/** How much of a daily figure has accrued so far today, at `now`'s local time. */
export function accruedToday(dailyCents: number, now: Date): number {
  const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  return (dailyCents * seconds) / 86_400;
}
