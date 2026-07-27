import type { RecurringCadence } from "./types";

/** Minimal shape `computeNextOccurrence`/`formatCadenceLabel` need - deliberately a subset of
 *  `RecurringRule` (not the full DB row) so this stays pure/DB-free and directly unit-testable. */
export interface RecurringSchedule {
  cadence: RecurringCadence;
  day_of_month: number | null;
  day_of_week: number | null;
  start_date: string;
}

function toLocalDate(iso: string): Date {
  // ISO date-only strings (YYYY-MM-DD) parse as UTC midnight, which can roll back a day in
  // negative-offset timezones once formatted/compared locally - same fix as utils.ts's
  // formatDate.
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function clampDayOfMonth(year: number, month: number, day: number): number {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return Math.min(day, lastDay);
}

/** Mon=0..Sun=6, matching the `(strftime('%w',date)+6)%7` convention used elsewhere in the app
 *  (e.g. weekend-spending insight, budget weekly mini-bars). */
function dowMonBased(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/**
 * Computes the next occurrence of a recurring rule on/after `from` (defaults to today), never
 * before the rule's `start_date`. Pure/deterministic (no DB access), so it's directly unit-
 * testable without a running app.
 *
 * - monthly: `day_of_month` clamped to the real length of each month (e.g. 31 in February
 *   lands on the 28th/29th instead of overflowing into March).
 * - weekly/biweekly: anchored to the first occurrence of `day_of_week` on/after `start_date`,
 *   so a biweekly rule stays on a stable fortnightly cadence tied to when it was created,
 *   rather than "whichever week happens to match today".
 */
export function computeNextOccurrence(rule: RecurringSchedule, from: Date = new Date()): Date {
  const start = startOfDay(toLocalDate(rule.start_date));
  const today = startOfDay(from);
  const floor = today > start ? today : start;

  if (rule.cadence === "monthly") {
    const day = rule.day_of_month ?? 1;
    let year = floor.getFullYear();
    let month = floor.getMonth();
    let candidate = new Date(year, month, clampDayOfMonth(year, month, day));
    if (candidate < floor) {
      month += 1;
      if (month > 11) { month = 0; year += 1; }
      candidate = new Date(year, month, clampDayOfMonth(year, month, day));
    }
    return candidate;
  }

  // weekly / biweekly
  const targetDow = rule.day_of_week ?? dowMonBased(start);
  const anchor = new Date(start);
  while (dowMonBased(anchor) !== targetDow) anchor.setDate(anchor.getDate() + 1);

  if (floor <= anchor) return anchor;

  const stepDays = rule.cadence === "biweekly" ? 14 : 7;
  const elapsedDays = Math.round((floor.getTime() - anchor.getTime()) / 86_400_000);
  const stepsPassed = Math.ceil(elapsedDays / stepDays);
  const next = new Date(anchor);
  next.setDate(next.getDate() + stepsPassed * stepDays);
  return next;
}

/** Whole days between `from` (defaults to today) and `date`, both floored to local midnight -
 *  negative if `date` is in the past. */
export function daysUntil(date: Date, from: Date = new Date()): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(from).getTime()) / 86_400_000);
}

const ORDINAL_DAY_LABELS: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 21: "21st", 22: "22nd", 23: "23rd", 31: "31st" };
function ordinal(day: number): string {
  if (ORDINAL_DAY_LABELS[day]) return ORDINAL_DAY_LABELS[day];
  return `${day}th`;
}

const DOW_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Human-readable cadence description, e.g. "Monthly on the 1st" / "Every other Friday". */
export function formatCadenceLabel(rule: RecurringSchedule): string {
  if (rule.cadence === "monthly") {
    return `Monthly on the ${ordinal(rule.day_of_month ?? 1)}`;
  }
  const label = DOW_LABELS[rule.day_of_week ?? 0];
  return rule.cadence === "biweekly" ? `Every other ${label}` : `Weekly on ${label}`;
}
