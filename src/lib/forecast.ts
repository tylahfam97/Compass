import type { RecurringCadence } from "./types";
import { computeNextOccurrence, type RecurringSchedule } from "./recurring";

/**
 * Forward-looking cash flow projection: given today's checking balance, the bills and income
 * we know are coming, and a baseline for everyday spending, what does the balance look like
 * over the next N days and does it ever dip below zero?
 *
 * Deliberately pure and synchronous (no DB access, no async) for two reasons: it's directly
 * unit-testable, and the what-if controls on the Plan page can recompute it inside a `useMemo`
 * on every slider tick with no round trip - the same split `simulateCustomDebtPayoff` uses in
 * agent.ts. DB gathering lives in `forecastData.ts`.
 *
 * Scope note: checking/debit accounts only. Credit cards are deliberately excluded - "will I
 * make it to payday" is a question about spendable cash, and folding in revolving balances
 * makes the number much harder to explain than it is useful.
 */

const MS_PER_DAY = 86_400_000;

/** Whether an event is a bill the user told us about or one we inferred from their history. */
export type ForecastEventSource = "rule" | "detected";

export interface ForecastEvent {
  key: string;
  /** YYYY-MM-DD */
  date: string;
  description: string;
  /** Signed: negative is money out, positive is money in. */
  amountCents: number;
  source: ForecastEventSource;
  categoryName: string | null;
  categoryColor: string | null;
}

/** A recurring schedule plus the details needed to turn each occurrence into an event. */
export interface ForecastRule extends RecurringSchedule {
  id: number;
  description: string;
  amount_cents: number;
  source: ForecastEventSource;
  category_name?: string | null;
  category_color?: string | null;
}

export interface ForecastDay {
  date: string;
  /** Projected balance at the end of this day. */
  balanceCents: number;
  events: ForecastEvent[];
  /** Everyday spending assumed on this day, as a positive number. */
  baselineCents: number;
}

export interface ForecastResult {
  days: ForecastDay[];
  /** The lowest projected balance in the window - the number that actually matters. */
  lowPoint: ForecastDay | null;
  /** Every day the projection is below zero. */
  shortfallDays: ForecastDay[];
  /** The first day the projection goes below zero, if it ever does. */
  firstShortfall: ForecastDay | null;
  /** Next money-in event after the start date. */
  nextIncome: ForecastEvent | null;
  /** True if the balance stays at or above zero all the way to `nextIncome`. */
  makesItToPayday: boolean;
  totalIncomeCents: number;
  totalBillsCents: number;
  /** What can be spent today without driving the projected low point below `bufferCents`. */
  safeToSpendCents: number;
}

export interface ProjectCashFlowInput {
  startingBalanceCents: number;
  /** YYYY-MM-DD, normally today. */
  startDate: string;
  days: number;
  events: ForecastEvent[];
  /** Everyday non-bill spending per day, as a positive number. */
  dailyBaselineCents: number;
  /** Cash the user wants to keep untouched; subtracted from safe-to-spend. */
  bufferCents?: number;
}

function toLocalDate(iso: string): Date {
  // Date-only ISO strings parse as UTC midnight, which rolls back a day in negative-offset
  // timezones - same guard as utils.ts/recurring.ts.
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Stops a malformed cadence from looping forever; far more than any real 90-day window needs. */
const MAX_OCCURRENCES_PER_RULE = 400;

/**
 * Expands recurring rules into every occurrence falling within [from, to]. `computeNextOccurrence`
 * only ever returns the single next date, so this walks it forward one occurrence at a time.
 */
export function expandOccurrences(rules: ForecastRule[], from: Date, to: Date): ForecastEvent[] {
  const events: ForecastEvent[] = [];

  for (const rule of rules) {
    let cursor = from;
    for (let i = 0; i < MAX_OCCURRENCES_PER_RULE; i++) {
      const next = computeNextOccurrence(rule, cursor);
      if (next.getTime() > to.getTime()) break;
      const date = toISODate(next);
      events.push({
        key: `${rule.source}-${rule.id}-${date}`,
        date,
        description: rule.description,
        amountCents: rule.amount_cents,
        source: rule.source,
        categoryName: rule.category_name ?? null,
        categoryColor: rule.category_color ?? null,
      });
      cursor = addDays(next, 1);
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Turns a charge inferred from transaction history into a schedule we can project forward.
 *
 * `detectRecurringCharges` only reports charges with consecutive-month streaks, so monthly is
 * the right cadence, and the day is taken from when it was last seen. Charges that actually
 * follow an "nth weekday" pattern (a "3rd Thursday" bill) will land within a few days rather
 * than exactly - which is why detected charges are shown as lower-confidence in the UI.
 */
export function detectedChargeToRule(
  charge: {
    description: string;
    amount_cents: number;
    last_seen: string;
    category_name?: string | null;
    category_color?: string | null;
  },
  index: number
): ForecastRule {
  return {
    // Negative so an inferred charge's id can never collide with a real rule's.
    id: -(index + 1),
    description: charge.description,
    amount_cents: -Math.abs(charge.amount_cents),
    source: "detected",
    cadence: "monthly",
    day_of_month: toLocalDate(charge.last_seen).getDate(),
    day_of_week: null,
    start_date: charge.last_seen,
    category_name: charge.category_name ?? null,
    category_color: charge.category_color ?? null,
  };
}

const OCCURRENCES_PER_MONTH: Record<RecurringCadence, number> = {
  monthly: 1,
  weekly: 52 / 12,
  biweekly: 26 / 12,
};

/** A rule's cost normalised to "per month", so cadences can be compared and summed. */
export function monthlyEquivalentCents(rule: { cadence: RecurringCadence; amount_cents: number }): number {
  return Math.round(rule.amount_cents * OCCURRENCES_PER_MONTH[rule.cadence]);
}

/**
 * Everyday spending per day, derived by taking average monthly expenses and removing the bills
 * we're already projecting individually - otherwise every known bill would be counted twice,
 * once as an event and again inside the average it contributed to.
 */
export function deriveDailyBaselineCents(
  avgMonthlyExpenseCents: number,
  knownMonthlyBillsCents: number
): number {
  return Math.max(0, Math.round((avgMonthlyExpenseCents - knownMonthlyBillsCents) / 30));
}

export function projectCashFlow(input: ProjectCashFlowInput): ForecastResult {
  const { startingBalanceCents, startDate, days, events, dailyBaselineCents } = input;
  const buffer = input.bufferCents ?? 0;

  const byDate = new Map<string, ForecastEvent[]>();
  for (const e of events) {
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }

  const start = toLocalDate(startDate);
  const out: ForecastDay[] = [];
  let balance = startingBalanceCents;
  let totalIncome = 0;
  let totalBills = 0;

  for (let i = 0; i < days; i++) {
    const date = toISODate(addDays(start, i));
    const dayEvents = byDate.get(date) ?? [];

    for (const e of dayEvents) {
      balance += e.amountCents;
      if (e.amountCents > 0) totalIncome += e.amountCents;
      else totalBills += Math.abs(e.amountCents);
    }
    balance -= dailyBaselineCents;

    out.push({ date, balanceCents: balance, events: dayEvents, baselineCents: dailyBaselineCents });
  }

  let lowPoint: ForecastDay | null = null;
  for (const day of out) {
    if (!lowPoint || day.balanceCents < lowPoint.balanceCents) lowPoint = day;
  }

  const shortfallDays = out.filter((d) => d.balanceCents < 0);
  const firstShortfall = shortfallDays[0] ?? null;

  const nextIncome = events.find((e) => e.amountCents > 0 && e.date >= startDate) ?? null;
  const makesItToPayday = nextIncome
    ? !out.some((d) => d.date <= nextIncome.date && d.balanceCents < 0)
    : !firstShortfall;

  return {
    days: out,
    lowPoint,
    shortfallDays,
    firstShortfall,
    nextIncome,
    makesItToPayday,
    totalIncomeCents: totalIncome,
    totalBillsCents: totalBills,
    safeToSpendCents: Math.max(0, (lowPoint?.balanceCents ?? startingBalanceCents) - buffer),
  };
}

/** Whole days from `from` to `iso`, for "in 6 days" style labels. */
export function daysFromToday(iso: string, from: Date = new Date()): number {
  const a = toLocalDate(iso).getTime();
  const b = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  return Math.round((a - b) / MS_PER_DAY);
}
