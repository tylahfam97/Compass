import { chargeMatchesRule } from "../forecast";

/**
 * The shape of a month's money: what came in, how much of it was spoken for before the month
 * started (scheduled bills the user confirmed in Plan, recurring charges Compass detected),
 * what was spent freely, and what was left. Pure: the page and the engine feed it rows and
 * both read the same answer.
 *
 * Accounting follows reportingSql.ts: income is positive rows on non credit/loan accounts;
 * expenses are negative rows on any account; categories 20 (Transfers) and 29 (Excluded)
 * never count.
 */

export interface ShapeTxn {
  date: string;
  amount_cents: number;
  description: string;
  account_type: string;
  category_id: number | null;
}

export interface ScheduledLike {
  description: string;
  amount_cents: number;
}

export type ExpenseKind = "bills" | "recurring" | "flexible";

export interface MonthShape {
  month: string;
  incomeCents: number;
  billsCents: number;
  recurringCents: number;
  flexibleCents: number;
  /** Income minus everything spent. Negative when the month ran over. */
  leftCents: number;
  expenseCount: number;
}

export interface FixedFlexibleSummary {
  months: MonthShape[];
  avgIncomeCents: number;
  avgBillsCents: number;
  avgRecurringCents: number;
  avgFlexibleCents: number;
  avgLeftCents: number;
  /** Shares of average income, 0..1 (left may be negative). Null shares when there is no income. */
  billsShare: number | null;
  recurringShare: number | null;
  flexibleShare: number | null;
  leftShare: number | null;
  /** Bills plus recurring as a share of income: the money committed before the month starts. */
  committedShare: number | null;
}

const EXCLUDED_CATEGORIES = new Set([20, 29]);

export function isIncomeTxn(t: ShapeTxn): boolean {
  return t.amount_cents > 0 && !(t.category_id !== null && EXCLUDED_CATEGORIES.has(t.category_id))
    && t.account_type !== "credit" && t.account_type !== "loan";
}

export function isExpenseTxn(t: ShapeTxn): boolean {
  return t.amount_cents < 0 && !(t.category_id !== null && EXCLUDED_CATEGORIES.has(t.category_id));
}

/** Which bucket an expense belongs to: a confirmed rule wins over a detected charge. */
export function classifyExpense(t: ShapeTxn, bills: ScheduledLike[], detected: ScheduledLike[]): ExpenseKind {
  const probe = { description: t.description, amount_cents: t.amount_cents };
  if (bills.some((b) => b.amount_cents < 0 && chargeMatchesRule(probe, b))) return "bills";
  if (detected.some((d) => chargeMatchesRule(probe, d))) return "recurring";
  return "flexible";
}

export function shapeMonth(txns: ShapeTxn[], month: string, bills: ScheduledLike[], detected: ScheduledLike[]): MonthShape {
  const shape: MonthShape = { month, incomeCents: 0, billsCents: 0, recurringCents: 0, flexibleCents: 0, leftCents: 0, expenseCount: 0 };
  for (const t of txns) {
    if (t.date.slice(0, 7) !== month) continue;
    if (isIncomeTxn(t)) { shape.incomeCents += t.amount_cents; continue; }
    if (!isExpenseTxn(t)) continue;
    shape.expenseCount++;
    const cents = -t.amount_cents;
    const kind = classifyExpense(t, bills, detected);
    if (kind === "bills") shape.billsCents += cents;
    else if (kind === "recurring") shape.recurringCents += cents;
    else shape.flexibleCents += cents;
  }
  shape.leftCents = shape.incomeCents - shape.billsCents - shape.recurringCents - shape.flexibleCents;
  return shape;
}

/**
 * Averages the shape over the given months (normally the last one to three complete months
 * that had income). Returns null when no months are supplied.
 */
export function summarizeFixedFlexible(
  txns: ShapeTxn[],
  bills: ScheduledLike[],
  detected: ScheduledLike[],
  months: string[]
): FixedFlexibleSummary | null {
  if (months.length === 0) return null;
  const shapes = months.map((m) => shapeMonth(txns, m, bills, detected));
  const n = shapes.length;
  const avg = (pick: (s: MonthShape) => number) => Math.round(shapes.reduce((sum, s) => sum + pick(s), 0) / n);
  const avgIncomeCents = avg((s) => s.incomeCents);
  const avgBillsCents = avg((s) => s.billsCents);
  const avgRecurringCents = avg((s) => s.recurringCents);
  const avgFlexibleCents = avg((s) => s.flexibleCents);
  const avgLeftCents = avgIncomeCents - avgBillsCents - avgRecurringCents - avgFlexibleCents;
  const share = (cents: number) => (avgIncomeCents > 0 ? cents / avgIncomeCents : null);
  return {
    months: shapes,
    avgIncomeCents, avgBillsCents, avgRecurringCents, avgFlexibleCents, avgLeftCents,
    billsShare: share(avgBillsCents),
    recurringShare: share(avgRecurringCents),
    flexibleShare: share(avgFlexibleCents),
    leftShare: share(avgLeftCents),
    committedShare: share(avgBillsCents + avgRecurringCents),
  };
}

/** Months, newest first, that have any income among `txns`, from a candidate list. */
export function monthsWithIncome(txns: ShapeTxn[], candidates: string[]): string[] {
  const income = new Set<string>();
  for (const t of txns) if (isIncomeTxn(t)) income.add(t.date.slice(0, 7));
  return candidates.filter((m) => income.has(m));
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export interface NoSpendDays {
  month: string;
  noSpendDays: number;
  daysInMonth: number;
  expenseCount: number;
}

/** Days of a complete month with no flexible spending at all (bills and recurring charges do not count against the streak). */
export function countNoSpendDays(txns: ShapeTxn[], month: string, bills: ScheduledLike[], detected: ScheduledLike[]): NoSpendDays {
  const spentDays = new Set<string>();
  let expenseCount = 0;
  for (const t of txns) {
    if (t.date.slice(0, 7) !== month || !isExpenseTxn(t)) continue;
    expenseCount++;
    if (classifyExpense(t, bills, detected) === "flexible") spentDays.add(t.date);
  }
  const total = daysInMonth(month);
  return { month, noSpendDays: total - spentDays.size, daysInMonth: total, expenseCount };
}

export interface PaydayBurst {
  /** Share of the month's flexible spending that happened within `windowDays` after a deposit. */
  share: number;
  /** Share of the month's days those windows cover. */
  coveredShare: number;
  deposits: number;
}

/**
 * How much of a month's flexible spending lands in the few days right after a paycheck.
 * Returns null when the month has no qualifying deposit or no flexible spending.
 */
export function paydayBurstShare(
  txns: ShapeTxn[],
  month: string,
  bills: ScheduledLike[],
  detected: ScheduledLike[],
  options: { minDepositCents?: number; windowDays?: number } = {}
): PaydayBurst | null {
  const { minDepositCents = 50000, windowDays = 3 } = options;
  const inMonth = txns.filter((t) => t.date.slice(0, 7) === month);
  const depositDates = [...new Set(inMonth.filter((t) => isIncomeTxn(t) && t.amount_cents >= minDepositCents).map((t) => t.date))].sort();
  if (depositDates.length === 0) return null;

  const covered = new Set<string>();
  for (const d of depositDates) {
    const start = new Date(`${d}T00:00:00`);
    for (let i = 0; i <= windowDays; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const isoDay = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      if (isoDay.slice(0, 7) === month) covered.add(isoDay);
    }
  }

  let total = 0;
  let inWindow = 0;
  for (const t of inMonth) {
    if (!isExpenseTxn(t) || classifyExpense(t, bills, detected) !== "flexible") continue;
    total += -t.amount_cents;
    if (covered.has(t.date)) inWindow += -t.amount_cents;
  }
  if (total === 0) return null;
  return { share: inWindow / total, coveredShare: covered.size / daysInMonth(month), deposits: depositDates.length };
}
