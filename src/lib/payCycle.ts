import { merchantKey } from "./merchants";
import { classifyExpense, type ScheduledLike } from "./insights/shape";
import { EXCLUDED_CATEGORY_ID, TRANSFER_CATEGORY_ID } from "./types";

/**
 * The Watch: the pay cycle as the unit of time. Paydays come from the user's own Plan schedule
 * when one exists, otherwise from the rhythm of payroll deposits. Everyday spending is then
 * read cycle by cycle, aligned on days since payday, so today's pace can be set against the
 * household's own usual curve. Pure; payCycleData.ts gathers the rows.
 */

export interface PayCycleTxn {
  date: string;
  amount_cents: number;
  category_id: number | null;
  category_name?: string | null;
  account_type: string;
  description: string;
}

export interface Deposit {
  date: string;
  amount_cents: number;
  description: string;
}

export interface PayCycleDetection {
  /** Known paydays, ascending. Planned schedules include future dates; detected ones do not. */
  paydays: string[];
  lastPayday: string;
  nextPayday: string;
  cadenceDays: number;
  source: "planned" | "detected";
  /** Detected only: the payer's description as the bank writes it, and how many deposits matched. */
  payer?: string;
  depositCount?: number;
}

const DAY_MS = 86_400_000;

export function isoToDate(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

export function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

export function daysBetweenIso(from: string, to: string): number {
  return Math.round((isoToDate(to).getTime() - isoToDate(from).getTime()) / DAY_MS);
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface DetectInput {
  /** Occurrences of the user's income rules over a window around today, from Plan. */
  plannedPaydays: string[];
  deposits: Deposit[];
  today: string;
  minDepositCents?: number;
}

/**
 * Planned paydays win whenever the schedule brackets today. Otherwise the payer with the most
 * sizeable deposits sets the rhythm, provided the gaps are regular (weekends and holidays shift
 * a payday by a day or two, so a little spread is allowed) and the last deposit is recent.
 */
export function detectPayCycle(input: DetectInput): PayCycleDetection | null {
  const { today } = input;
  const planned = [...new Set(input.plannedPaydays)].sort();
  const past = planned.filter((d) => d <= today);
  const future = planned.filter((d) => d > today);
  if (past.length >= 1 && future.length >= 1 && planned.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < planned.length; i++) gaps.push(daysBetweenIso(planned[i - 1], planned[i]));
    const cadence = Math.max(1, median(gaps.filter((g) => g > 0)));
    return { paydays: planned, lastPayday: past[past.length - 1], nextPayday: future[0], cadenceDays: cadence, source: "planned" };
  }

  const min = input.minDepositCents ?? 50_000;
  const groups = new Map<string, Deposit[]>();
  for (const d of input.deposits) {
    if (d.amount_cents < min || d.date > today) continue;
    const key = merchantKey(d.description) || d.description.trim().toUpperCase();
    const list = groups.get(key);
    if (list) list.push(d); else groups.set(key, [d]);
  }
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length || b.reduce((s, d) => s + d.amount_cents, 0) - a.reduce((s, d) => s + d.amount_cents, 0));
  const payer = ranked[0];
  if (!payer || payer.length < 3) return null;
  const dates = [...new Set(payer.map((d) => d.date))].sort();
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const g = daysBetweenIso(dates[i - 1], dates[i]);
    if (g > 0 && g <= 45) gaps.push(g);
  }
  if (gaps.length < 2) return null;
  const cadence = median(gaps);
  if (cadence < 6 || cadence > 35) return null;
  if (Math.max(...gaps) - Math.min(...gaps) > 5) return null;
  const lastPayday = dates[dates.length - 1];
  // A payer that has gone quiet for two cycles is not a rhythm to plan around.
  if (daysBetweenIso(lastPayday, today) > cadence * 2) return null;
  let nextPayday = addDaysIso(lastPayday, cadence);
  while (nextPayday <= today) nextPayday = addDaysIso(nextPayday, cadence);
  const names = new Map<string, number>();
  for (const d of payer) names.set(d.description.trim(), (names.get(d.description.trim()) ?? 0) + 1);
  const label = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return { paydays: dates, lastPayday, nextPayday, cadenceDays: cadence, source: "detected", payer: label, depositCount: payer.length };
}

export interface CycleSpend {
  start: string;
  /** Exclusive: the next payday. */
  end: string;
  days: number;
  /** Cumulative everyday spending by day since payday, index 0 = payday itself. */
  cumulative: number[];
  totalCents: number;
}

function isEverydaySpend(t: PayCycleTxn, bills: ScheduledLike[], detected: ScheduledLike[]): boolean {
  if (t.amount_cents >= 0) return false;
  if (t.category_id === TRANSFER_CATEGORY_ID || t.category_id === EXCLUDED_CATEGORY_ID) return false;
  if (t.account_type !== "checking" && t.account_type !== "credit") return false;
  const kind = classifyExpense(t, bills, detected);
  return kind === "flexible" || kind === "oneoff";
}

/** Cumulative everyday spending across one cycle, bills and recurring charges left out. */
export function cycleSpend(start: string, end: string, txns: PayCycleTxn[], bills: ScheduledLike[], detected: ScheduledLike[]): CycleSpend {
  const days = Math.max(1, daysBetweenIso(start, end));
  const daily = new Array<number>(days).fill(0);
  for (const t of txns) {
    if (t.date < start || t.date >= end || !isEverydaySpend(t, bills, detected)) continue;
    const i = Math.min(days - 1, daysBetweenIso(start, t.date));
    daily[i] += -t.amount_cents;
  }
  const cumulative: number[] = [];
  let run = 0;
  for (const v of daily) { run += v; cumulative.push(run); }
  return { start, end, days, cumulative, totalCents: run };
}

export interface WatchSummary {
  detection: PayCycleDetection;
  cycleDays: number;
  /** Days since payday, 0 on payday itself. */
  dayIndex: number;
  daysLeft: number;
  current: CycleSpend;
  past: CycleSpend[];
  /** The usual cumulative curve, averaged over past cycles and aligned on days since payday. */
  typical: number[];
  typicalTotalCents: number;
  spentSoFarCents: number;
  usualByNowCents: number;
  /** Positive when ahead of the usual pace (spending faster). */
  paceDeltaCents: number;
  /** What each remaining day can carry and still land on the usual total. */
  leftPerDayCents: number;
  /** Paydays falling in today's calendar month, and whether that makes it a bonus month. */
  monthPaydays: number;
  threePaycheckMonth: boolean;
}

export interface WatchInput {
  detection: PayCycleDetection;
  txns: PayCycleTxn[];
  bills: ScheduledLike[];
  detected: ScheduledLike[];
  today: string;
  maxPastCycles?: number;
}

export function summarizeWatch(input: WatchInput): WatchSummary {
  const { detection, today } = input;
  const maxPast = input.maxPastCycles ?? 6;
  const knownPast = detection.paydays.filter((d) => d <= detection.lastPayday);
  const pairs: [string, string][] = [];
  for (let i = 1; i < knownPast.length; i++) pairs.push([knownPast[i - 1], knownPast[i]]);
  const past = pairs.slice(-maxPast).map(([s, e]) => cycleSpend(s, e, input.txns, input.bills, input.detected));
  const current = cycleSpend(detection.lastPayday, detection.nextPayday, input.txns, input.bills, input.detected);
  const cycleDays = current.days;
  const dayIndex = Math.max(0, Math.min(cycleDays - 1, daysBetweenIso(detection.lastPayday, today)));
  const daysLeft = Math.max(0, daysBetweenIso(today, detection.nextPayday));

  const typical: number[] = [];
  for (let i = 0; i < cycleDays; i++) {
    if (past.length === 0) { typical.push(0); continue; }
    const sum = past.reduce((s, c) => s + c.cumulative[Math.min(i, c.days - 1)], 0);
    typical.push(Math.round(sum / past.length));
  }
  const typicalTotalCents = typical.length > 0 ? typical[typical.length - 1] : 0;
  const spentSoFarCents = current.cumulative[dayIndex] ?? 0;
  const usualByNowCents = typical[dayIndex] ?? 0;
  const leftPerDayCents = daysLeft > 0 ? Math.round(Math.max(0, typicalTotalCents - spentSoFarCents) / daysLeft) : 0;

  // Paydays in this calendar month: known dates plus the rhythm projected either way.
  const monthKey = today.slice(0, 7);
  const inMonth = new Set(detection.paydays.filter((d) => d.slice(0, 7) === monthKey));
  if (detection.nextPayday.slice(0, 7) === monthKey) inMonth.add(detection.nextPayday);
  let probe = addDaysIso(detection.nextPayday, detection.cadenceDays);
  while (probe.slice(0, 7) === monthKey) { inMonth.add(probe); probe = addDaysIso(probe, detection.cadenceDays); }
  probe = addDaysIso(detection.lastPayday, -detection.cadenceDays);
  while (probe.slice(0, 7) === monthKey) { inMonth.add(probe); probe = addDaysIso(probe, -detection.cadenceDays); }
  const monthPaydays = inMonth.size;

  return {
    detection, cycleDays, dayIndex, daysLeft, current, past, typical, typicalTotalCents,
    spentSoFarCents, usualByNowCents, paceDeltaCents: spentSoFarCents - usualByNowCents, leftPerDayCents,
    monthPaydays, threePaycheckMonth: detection.cadenceDays <= 16 && monthPaydays >= 3,
  };
}
