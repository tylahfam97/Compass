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
  /** Optional; lets flexible spending exclude investment-like categories and name the
   *  breakdown rows. Rows without it are treated as ordinary spending. */
  category_name?: string | null;
}

export interface ScheduledLike {
  description: string;
  amount_cents: number;
}

export type ExpenseKind = "bills" | "recurring" | "flexible" | "invested" | "oneoff";

/** Money moved into assets, not consumed - it is saving, not flexible spending. */
const INVESTMENT_CATEGORY_RE = /crypto|invest|brokerage|trading|retirement|401k|\bira\b/i;
/** A single expense at least this large is a one-off, not part of a typical month. */
export const LARGE_ONE_OFF_MIN_CENTS = 100_000;

export interface MonthShape {
  month: string;
  incomeCents: number;
  billsCents: number;
  recurringCents: number;
  flexibleCents: number;
  /** Outflows into investment-like categories (crypto, brokerage...) - saving, not spending. */
  investedCents: number;
  /** Single purchases of $1,000+ - real money, but not the shape of a typical month. */
  oneOffCents: number;
  /** Income minus everything that went out. Negative when the month ran over. */
  leftCents: number;
  expenseCount: number;
}

export interface FixedFlexibleSummary {
  months: MonthShape[];
  avgIncomeCents: number;
  /** Where `avgIncomeCents` came from: the user's own Plan rules, or averaged deposits when
   *  nothing is scheduled. Planned is the honest basis for "what can this month afford" -
   *  supplemental deposits are not money to plan bills around. */
  incomeBasis: "planned" | "actual";
  /** What actually landed in an average month, planned or not - the supplemental cushion is
   *  the difference between this and `avgIncomeCents`. */
  avgActualIncomeCents: number;
  /** Planned monthly equivalent of the user's bill rules when the basis is planned (matches
   *  the Plan page exactly); otherwise the average of actual payments matched to rules. */
  avgBillsCents: number;
  /** Average of actual payments matched to bill rules - the measured counterpart, so a view
   *  of what actually happened never mixes planned bills with measured spending. */
  avgMeasuredBillsCents: number;
  avgRecurringCents: number;
  avgFlexibleCents: number;
  avgInvestedCents: number;
  avgOneOffCents: number;
  avgLeftCents: number;
  /** The largest flexible categories, averaged per month, for the breakdown under the bar. */
  flexibleTopCategories: { name: string; cents: number }[];
  /** Shares of average income, 0..1 (left may be negative). Null shares when there is no income. */
  billsShare: number | null;
  recurringShare: number | null;
  flexibleShare: number | null;
  leftShare: number | null;
  /** Bills plus recurring as a share of income: the money committed before the month starts. */
  committedShare: number | null;
}

/** The user's own Plan schedule, normalised to monthly figures - see plannedRules.ts. */
export interface PlannedBasis {
  incomeCents: number;
  billsCents: number;
}

const EXCLUDED_CATEGORIES = new Set([20, 29]);

export function isIncomeTxn(t: ShapeTxn): boolean {
  return t.amount_cents > 0 && !(t.category_id !== null && EXCLUDED_CATEGORIES.has(t.category_id))
    && t.account_type !== "credit" && t.account_type !== "loan";
}

export function isExpenseTxn(t: ShapeTxn): boolean {
  return t.amount_cents < 0 && !(t.category_id !== null && EXCLUDED_CATEGORIES.has(t.category_id));
}

/** Which bucket an expense belongs to: a confirmed rule wins over a detected charge; money
 *  into investment-like categories is saving; a $1,000+ single purchase is a one-off. */
export function classifyExpense(t: ShapeTxn, bills: ScheduledLike[], detected: ScheduledLike[]): ExpenseKind {
  const probe = { description: t.description, amount_cents: t.amount_cents };
  if (bills.some((b) => b.amount_cents < 0 && chargeMatchesRule(probe, b))) return "bills";
  if (detected.some((d) => chargeMatchesRule(probe, d))) return "recurring";
  if (t.category_name && INVESTMENT_CATEGORY_RE.test(t.category_name)) return "invested";
  if (-t.amount_cents >= LARGE_ONE_OFF_MIN_CENTS) return "oneoff";
  return "flexible";
}

export function shapeMonth(txns: ShapeTxn[], month: string, bills: ScheduledLike[], detected: ScheduledLike[]): MonthShape {
  const shape: MonthShape = { month, incomeCents: 0, billsCents: 0, recurringCents: 0, flexibleCents: 0, investedCents: 0, oneOffCents: 0, leftCents: 0, expenseCount: 0 };
  for (const t of txns) {
    if (t.date.slice(0, 7) !== month) continue;
    if (isIncomeTxn(t)) { shape.incomeCents += t.amount_cents; continue; }
    if (!isExpenseTxn(t)) continue;
    shape.expenseCount++;
    const cents = -t.amount_cents;
    const kind = classifyExpense(t, bills, detected);
    if (kind === "bills") shape.billsCents += cents;
    else if (kind === "recurring") shape.recurringCents += cents;
    else if (kind === "invested") shape.investedCents += cents;
    else if (kind === "oneoff") shape.oneOffCents += cents;
    else shape.flexibleCents += cents;
  }
  shape.leftCents = shape.incomeCents - shape.billsCents - shape.recurringCents - shape.flexibleCents - shape.investedCents - shape.oneOffCents;
  return shape;
}

/**
 * Averages the shape over the given months (normally the last one to three complete months
 * that had income). When the user scheduled income and bills in Plan, those planned monthly
 * figures are the basis - one-off deposits never stretch the track, and the bills segment
 * matches the Plan page instead of depending on descriptor matching. Investments and $1,000+
 * one-offs are reported separately, not as flexible spending. Returns null when no months are
 * supplied.
 */
export function summarizeFixedFlexible(
  txns: ShapeTxn[],
  bills: ScheduledLike[],
  detected: ScheduledLike[],
  months: string[],
  planned: PlannedBasis | null = null
): FixedFlexibleSummary | null {
  if (months.length === 0) return null;
  const shapes = months.map((m) => shapeMonth(txns, m, bills, detected));
  const n = shapes.length;
  const avg = (pick: (s: MonthShape) => number) => Math.round(shapes.reduce((sum, s) => sum + pick(s), 0) / n);
  const usePlanned = planned !== null && planned.incomeCents > 0;
  const avgActualIncomeCents = avg((s) => s.incomeCents);
  const avgIncomeCents = usePlanned ? planned.incomeCents : avgActualIncomeCents;
  const avgMeasuredBillsCents = avg((s) => s.billsCents);
  const avgBillsCents = usePlanned ? planned.billsCents : avgMeasuredBillsCents;
  const avgRecurringCents = avg((s) => s.recurringCents);
  const avgFlexibleCents = avg((s) => s.flexibleCents);
  const avgInvestedCents = avg((s) => s.investedCents);
  const avgOneOffCents = avg((s) => s.oneOffCents);
  // Bills that posted without matching their rule sit inside measured flexible; counting them
  // AND the planned bills would double-count, so up to the planned-vs-matched gap comes out.
  const presumedUnmatchedBills = usePlanned ? Math.max(0, avgBillsCents - avgMeasuredBillsCents) : 0;
  const dedupedFlexibleCents = Math.max(0, avgFlexibleCents - presumedUnmatchedBills);
  const avgLeftCents = avgIncomeCents - avgBillsCents - avgRecurringCents - dedupedFlexibleCents;

  const monthSet = new Set(months);
  const byCategory = new Map<string, number>();
  for (const t of txns) {
    if (!monthSet.has(t.date.slice(0, 7)) || !isExpenseTxn(t)) continue;
    if (classifyExpense(t, bills, detected) !== "flexible") continue;
    const name = t.category_name ?? "Uncategorized";
    byCategory.set(name, (byCategory.get(name) ?? 0) - t.amount_cents);
  }
  const flexibleTopCategories = [...byCategory.entries()]
    .map(([name, total]) => ({ name, cents: Math.round(total / n) }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 3);

  const share = (cents: number) => (avgIncomeCents > 0 ? cents / avgIncomeCents : null);
  return {
    months: shapes,
    avgIncomeCents, avgBillsCents, avgMeasuredBillsCents, avgRecurringCents, avgFlexibleCents, avgInvestedCents, avgOneOffCents, avgLeftCents,
    avgActualIncomeCents,
    incomeBasis: usePlanned ? "planned" : "actual",
    flexibleTopCategories,
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
    const kind = classifyExpense(t, bills, detected);
    if (kind === "flexible" || kind === "oneoff") spentDays.add(t.date);
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
