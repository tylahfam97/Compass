/**
 * Pure math for the Dashboard bearing instrument: how much of the month's income is spent,
 * how much is still committed to scheduled bills, and how much is free, as lengths on one
 * track. Kept free of React so it is unit-testable and can never produce NaN widths.
 */
export type MonthState = "past" | "current" | "future";

export interface BearingInput {
  incomeCents: number;
  spentCents: number;
  dueCents?: number;
  /** YYYY-MM */
  month: string;
  today?: Date;
}

export interface Bearing {
  monthState: MonthState;
  daysInMonth: number;
  daysLeft: number;
  /** Share of the month elapsed before today, 0 to 100. */
  elapsedPct: number;
  incomeKnown: boolean;
  spentPct: number;
  duePct: number;
  freePct: number;
  freeCents: number;
  overCents: number;
}

function parseMonth(month: string): { y: number; m: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeBearing(input: BearingInput): Bearing {
  const today = input.today ?? new Date();
  const parsed = parseMonth(input.month) ?? { y: today.getFullYear(), m: today.getMonth() + 1 };
  const daysInMonth = new Date(parsed.y, parsed.m, 0).getDate();
  const todayKey = today.getFullYear() * 100 + (today.getMonth() + 1);
  const monthKey = parsed.y * 100 + parsed.m;
  const monthState: MonthState = monthKey < todayKey ? "past" : monthKey > todayKey ? "future" : "current";

  const daysLeft = monthState === "past" ? 0 : monthState === "future" ? daysInMonth : daysInMonth - today.getDate() + 1;
  const elapsedPct = monthState === "past" ? 100 : monthState === "future" ? 0 : round1((100 * (today.getDate() - 1)) / daysInMonth);

  const income = Math.abs(input.incomeCents) || 0;
  const spent = Math.abs(input.spentCents) || 0;
  const due = Math.abs(input.dueCents ?? 0) || 0;
  const incomeKnown = income > 0;

  if (!incomeKnown) {
    return { monthState, daysInMonth, daysLeft, elapsedPct, incomeKnown, spentPct: 0, duePct: 0, freePct: 0, freeCents: 0, overCents: spent + due };
  }

  let spentPct = (100 * spent) / income;
  let duePct = (100 * due) / income;
  // Clamp so the segments never exceed the track: due gives way first, then spent.
  if (spentPct + duePct > 100) {
    duePct = Math.max(0, 100 - spentPct);
    if (spentPct > 100) spentPct = 100;
  }
  spentPct = round1(spentPct);
  duePct = round1(duePct);
  const freePct = round1(Math.max(0, 100 - spentPct - duePct));
  const freeCents = Math.max(0, income - spent - due);
  const overCents = Math.max(0, spent + due - income);
  return { monthState, daysInMonth, daysLeft, elapsedPct, incomeKnown, spentPct, duePct, freePct, freeCents, overCents };
}

/** First and last day of a YYYY-MM month as local YYYY-MM-DD strings (no timezone shift). */
export function monthBoundsIso(month: string): { start: string; end: string } {
  const parsed = parseMonth(month);
  if (!parsed) return { start: month, end: month };
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: fmt(new Date(parsed.y, parsed.m - 1, 1)), end: fmt(new Date(parsed.y, parsed.m, 0)) };
}
