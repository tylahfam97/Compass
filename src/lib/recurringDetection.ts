import { merchantKey } from "./merchants";

/**
 * Pure recurring-charge analysis. `detectRecurringCharges` in agent.ts does the database work
 * and hands each description's rows to `findRecurringStreak`; everything here is deterministic
 * and unit-tested without a database.
 *
 * A charge is recurring when it repeats in STRICTLY CONSECUTIVE calendar months on the same
 * day of month (within a few days) or the same "Nth weekday" (a "3rd Thursday" bill), anchored
 * to its most recent occurrence. Amount is deliberately not part of the match, so utility bills
 * and drifting subscriptions still count; the amount history is returned instead so callers can
 * notice a price change.
 */

export const RECURRING_DAY_TOLERANCE = 3; // +/- days still considered "the same day of month"

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function dayOfMonthOf(dateStr: string): number { return Number(dateStr.slice(8, 10)); }
export function monthKeyOf(dateStr: string): string { return dateStr.slice(0, 7); }
export function nthWeekdayOf(dateStr: string): { weekday: number; nth: number } {
  const d = new Date(`${dateStr}T00:00:00`);
  return { weekday: d.getDay(), nth: Math.ceil(d.getDate() / 7) };
}
export function shiftMonthKey(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export interface RecurringRow {
  description: string;
  amount_cents: number;
  date: string;
  category_name: string | null;
  category_color: string | null;
}

export interface RecurringStreak {
  txns: RecurringRow[];
  mode: "day" | "weekday";
}

/** Walks backward from the most recent transaction in `rows` (all sharing one description),
 *  through strictly consecutive months, matching either the anchor's day-of-month (within
 *  RECURRING_DAY_TOLERANCE days) or its exact "Nth weekday of month" - whichever produces the
 *  longer streak wins (ties favor day-of-month, since it's the more common/intuitive billing
 *  cadence). Returns null if the resulting streak is shorter than 2 months. */
export function findRecurringStreak(rows: RecurringRow[]): RecurringStreak | null {
  const byMonth = new Map<string, RecurringRow[]>();
  for (const r of rows) {
    const mk = monthKeyOf(r.date);
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk)!.push(r);
  }
  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return null;

  const lastMonth = months[months.length - 1];
  const lastMonthTxns = byMonth.get(lastMonth)!.slice().sort((a, b) => a.date.localeCompare(b.date));
  const anchor = lastMonthTxns[lastMonthTxns.length - 1];
  const anchorDay = dayOfMonthOf(anchor.date);
  const anchorNW = nthWeekdayOf(anchor.date);

  const buildStreak = (mode: "day" | "weekday"): RecurringRow[] => {
    const streak: RecurringRow[] = [anchor];
    let cursor = lastMonth;
    for (let i = months.length - 2; i >= 0; i--) {
      if (months[i] !== shiftMonthKey(cursor, -1)) break; // gap - streak stops here
      const match = byMonth.get(months[i])!.find((c) => {
        if (mode === "day") return Math.abs(dayOfMonthOf(c.date) - anchorDay) <= RECURRING_DAY_TOLERANCE;
        const nw = nthWeekdayOf(c.date);
        return nw.weekday === anchorNW.weekday && nw.nth === anchorNW.nth;
      });
      if (!match) break;
      streak.unshift(match);
      cursor = months[i];
    }
    return streak;
  };

  const dayStreak = buildStreak("day");
  const weekdayStreak = buildStreak("weekday");
  const [txns, mode] = weekdayStreak.length > dayStreak.length
    ? [weekdayStreak, "weekday" as const]
    : [dayStreak, "day" as const];
  return txns.length >= 2 ? { txns, mode } : null;
}

export function patternLabelFor(anchor: RecurringRow, mode: "day" | "weekday"): string {
  if (mode === "day") return `${ordinal(dayOfMonthOf(anchor.date))} of the month`;
  const { weekday, nth } = nthWeekdayOf(anchor.date);
  return `${ordinal(nth)} ${WEEKDAY_NAMES[weekday]} of the month`;
}

/** Absolute amounts of a streak, oldest first. */
export function amountHistoryOf(streak: RecurringStreak): number[] {
  return streak.txns.map((t) => Math.abs(t.amount_cents));
}

export interface PriceChange {
  previousCents: number;
  currentCents: number;
  /** Positive when the charge went up. */
  deltaCents: number;
  /** Signed fraction of the previous amount. */
  pct: number;
}

export interface PriceChangeOptions {
  minDeltaCents: number;
  minPct: number;
  /** How many consecutive occurrences the previous amount must have held; a step, not a wobble. */
  holdOccurrences: number;
  holdToleranceCents: number;
}

const DEFAULT_PRICE_CHANGE: PriceChangeOptions = { minDeltaCents: 100, minPct: 0.03, holdOccurrences: 2, holdToleranceCents: 50 };

/**
 * A subscription that quietly went up: the newest amount differs from the one before it, and
 * that previous amount had held steady. A utility bill that is different every month never
 * qualifies, which is the point.
 */
export function detectPriceChange(amountHistory: number[], options: Partial<PriceChangeOptions> = {}): PriceChange | null {
  const opts = { ...DEFAULT_PRICE_CHANGE, ...options };
  const n = amountHistory.length;
  if (n < opts.holdOccurrences + 1) return null;
  const current = Math.abs(amountHistory[n - 1]);
  const previous = Math.abs(amountHistory[n - 2]);
  for (let back = 3; back <= opts.holdOccurrences + 1; back++) {
    const idx = n - back;
    if (idx < 0) return null;
    if (Math.abs(Math.abs(amountHistory[idx]) - previous) > opts.holdToleranceCents) return null;
  }
  const delta = current - previous;
  if (Math.abs(delta) < opts.minDeltaCents || Math.abs(delta) < previous * opts.minPct) return null;
  return { previousCents: previous, currentCents: current, deltaCents: delta, pct: delta / previous };
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00`).getTime();
  const b = new Date(`${toIso}T00:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * A recurring charge is "new" when its streak is short AND the profile's history clearly
 * predates it - otherwise every charge in a freshly imported profile would be "new".
 */
export function isNewRecurring(
  charge: { first_seen: string; month_count: number },
  earliestTxnIso: string,
  todayIso: string,
  options: { maxStreak?: number; minHistoryDaysBefore?: number; maxAgeDays?: number } = {}
): boolean {
  const { maxStreak = 3, minHistoryDaysBefore = 45, maxAgeDays = 100 } = options;
  if (charge.month_count < 2 || charge.month_count > maxStreak) return false;
  if (daysBetween(earliestTxnIso, charge.first_seen) < minHistoryDaysBefore) return false;
  return daysBetween(charge.first_seen, todayIso) <= maxAgeDays;
}

export interface AnnualCharge {
  key: string;
  description: string;
  amountCents: number;
  lastDate: string;
  /** Expected next occurrence, one year after the last one. */
  expectedDate: string;
  occurrences: number;
}

/**
 * Yearly renewals: the same payee roughly a year apart (350 to 380 days), at least twice, with
 * no monthly cadence, whose next anniversary lands within `withinDays`. Needs over a year of
 * history by definition.
 */
export function findAnnualCharges(
  rows: { description: string; amount_cents: number; date: string }[],
  todayIso: string,
  options: { minCents?: number; withinDays?: number } = {}
): AnnualCharge[] {
  const { minCents = 2000, withinDays = 30 } = options;
  const groups = new Map<string, { description: string; amount_cents: number; date: string }[]>();
  for (const r of rows) {
    if (r.amount_cents >= 0 || Math.abs(r.amount_cents) < minCents) continue;
    const key = merchantKey(r.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const out: AnnualCharge[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    // A payee seen in four or more distinct months of the last year is a monthly charge, not
    // an annual one.
    const recentMonths = new Set(list.filter((r) => daysBetween(r.date, todayIso) <= 366).map((r) => monthKeyOf(r.date)));
    if (recentMonths.size >= 4) continue;
    let yearly = 0;
    for (let i = 1; i < list.length; i++) {
      const gap = daysBetween(list[i - 1].date, list[i].date);
      const a = Math.abs(list[i - 1].amount_cents);
      const b = Math.abs(list[i].amount_cents);
      if (gap >= 350 && gap <= 380 && Math.abs(a - b) <= Math.max(a, b) * 0.2) yearly++;
    }
    if (yearly === 0) continue;
    const last = list[list.length - 1];
    const expected = new Date(`${last.date}T00:00:00`);
    expected.setFullYear(expected.getFullYear() + 1);
    const expectedIso = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(expected.getDate()).padStart(2, "0")}`;
    const daysAway = daysBetween(todayIso, expectedIso);
    if (daysAway < -5 || daysAway > withinDays) continue;
    out.push({ key, description: last.description, amountCents: Math.abs(last.amount_cents), lastDate: last.date, expectedDate: expectedIso, occurrences: list.length });
  }
  return out.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
}
