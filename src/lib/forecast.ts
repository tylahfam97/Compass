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
  /** Money already spoken for after this day - every remaining bill and day of everyday
   *  spending left in the window. The gap between `balanceCents` and this is what's genuinely
   *  free to spend or save. */
  committedCents: number;
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
  /** Everyday spending assumed across the whole window. */
  baselineTotalCents: number;
  /**
   * Income in this window minus the bills scheduled against it. Deliberately does NOT subtract
   * the everyday baseline: that figure is average total spending, which already contains the
   * user's discretionary purchases - netting it off too would subtract discretionary spending
   * and then call the remainder discretionary.
   */
  afterBillsCents: number;
  /** Projected balance on the final day of the window. */
  endingBalanceCents: number;
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

    out.push({
      date, balanceCents: balance, events: dayEvents,
      baselineCents: dailyBaselineCents, committedCents: 0,
    });
  }

  // Reverse pass: what's still owed after each day. Has to run backwards because a day's
  // commitment depends on everything that comes after it.
  let stillOwed = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i].committedCents = stillOwed;
    const billsThatDay = out[i].events.reduce(
      (sum, e) => sum + (e.amountCents < 0 ? Math.abs(e.amountCents) : 0),
      0
    );
    stillOwed += billsThatDay + out[i].baselineCents;
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

  const baselineTotalCents = dailyBaselineCents * days;

  return {
    days: out,
    lowPoint,
    shortfallDays,
    firstShortfall,
    nextIncome,
    makesItToPayday,
    totalIncomeCents: totalIncome,
    totalBillsCents: totalBills,
    baselineTotalCents,
    afterBillsCents: totalIncome - totalBills,
    endingBalanceCents: out.length > 0 ? out[out.length - 1].balanceCents : startingBalanceCents,
    safeToSpendCents: Math.max(0, (lowPoint?.balanceCents ?? startingBalanceCents) - buffer),
  };
}

/** Whole days from `from` to `iso`, for "in 6 days" style labels. */
export function daysFromToday(iso: string, from: Date = new Date()): number {
  const a = toLocalDate(iso).getTime();
  const b = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  return Math.round((a - b) / MS_PER_DAY);
}

/** The three questions people ask about their balance. Each resolves to a different length. */
export type ForecastWindowMode = "month" | "paycheck" | "days30";

export interface ResolvedWindow {
  /** Number of days to project, inclusive of today. */
  days: number;
  /** Last day covered, YYYY-MM-DD. */
  endDate: string;
  /** True when "to next paycheck" was asked for but no income is scheduled, so this fell back
   *  to the rest of the month. */
  usedFallback: boolean;
}

const DAYS_30 = 30;

/**
 * Works out how many days a window covers. "To next paycheck" can't know its own length until
 * the paycheck has been located, so this takes the already-expanded event list.
 *
 * The paycheck window runs up to and including the day the money lands, so the user can see it
 * arrive - the low point that matters still falls before it.
 */
export function resolveForecastWindow(
  events: ForecastEvent[],
  today: Date,
  mode: ForecastWindowMode
): ResolvedWindow {
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const todayIso = toISODate(startOfToday);

  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const monthDays = daysInMonth - today.getDate() + 1;

  const nextPaycheck = events.find((e) => e.amountCents > 0 && e.date >= todayIso) ?? null;
  const usedFallback = mode === "paycheck" && !nextPaycheck;

  const days =
    mode === "days30" ? DAYS_30
    : mode === "paycheck" && nextPaycheck
      ? Math.max(1, daysFromToday(nextPaycheck.date, startOfToday) + 1)
      : monthDays;

  return { days, endDate: toISODate(addDays(startOfToday, days - 1)), usedFallback };
}

/** How pressing an action is - drives ordering and colour, nothing else. */
export type NextActionTone = "urgent" | "suggested" | "positive";

export interface NextAction {
  key: string;
  title: string;
  detail: string;
  tone: NextActionTone;
}

export interface NextActionContext {
  hasIncomeRule: boolean;
  detectedCount: number;
  dailyBaselineCents: number;
  /** Reference point for "how many days until the shortfall". */
  today?: Date;
}

/** A cushion thinner than this many days of everyday spending is worth flagging. */
const THIN_CUSHION_DAYS = 7;
/** Above this many days of cushion, suggest putting the surplus to work instead. */
const COMFORTABLE_CUSHION_DAYS = 45;

/**
 * Turns a projection into a short list of concrete things the user could do about it. The rest
 * of the app observes; this is the one place that recommends. Kept pure and rule-based - see the
 * offline-first rationale behind the rest of the insight engine.
 */
export function deriveNextActions(result: ForecastResult, context: NextActionContext): NextAction[] {
  const actions: NextAction[] = [];
  const { dailyBaselineCents, today = new Date() } = context;

  if (result.firstShortfall) {
    const daysAway = Math.max(1, daysFromToday(result.firstShortfall.date, today));
    const gap = Math.abs(result.lowPoint?.balanceCents ?? result.firstShortfall.balanceCents);
    const perDay = Math.ceil(gap / daysAway);
    actions.push({
      key: "cover_shortfall",
      title: `Find ${formatPlainCurrency(gap)} before ${result.firstShortfall.date}`,
      detail:
        `That's about ${formatPlainCurrency(perDay)} a day for the next ${daysAway} ` +
        `${daysAway === 1 ? "day" : "days"} - either trimmed from everyday spending or moved in from savings.`,
      tone: "urgent",
    });
  }

  if (!context.hasIncomeRule) {
    actions.push({
      key: "add_income",
      title: "Schedule your paycheck",
      detail:
        "With no income scheduled, this forecast only ever slopes downward. Adding your pay " +
        "makes every number here meaningful.",
      tone: result.firstShortfall ? "suggested" : "urgent",
    });
  }

  if (context.detectedCount > 0) {
    actions.push({
      key: "confirm_detected",
      title: `Confirm ${context.detectedCount} detected charge${context.detectedCount === 1 ? "" : "s"}`,
      detail:
        "Compass spotted these repeating in your history and is guessing at their timing. " +
        "Adding them as scheduled items pins them to the right date.",
      tone: "suggested",
    });
  }

  const cushionDays =
    dailyBaselineCents > 0 && result.lowPoint
      ? result.lowPoint.balanceCents / dailyBaselineCents
      : null;

  if (!result.firstShortfall && cushionDays !== null && cushionDays < THIN_CUSHION_DAYS) {
    actions.push({
      key: "thin_cushion",
      title: "Your cushion gets thin",
      detail:
        `At the low point you're down to roughly ${Math.max(0, Math.floor(cushionDays))} days of ` +
        "everyday spending. It holds, but there's little room for anything unexpected.",
      tone: "suggested",
    });
  }

  if (!result.firstShortfall && cushionDays !== null && cushionDays > COMFORTABLE_CUSHION_DAYS) {
    actions.push({
      key: "surplus",
      title: `You have room to move ${formatPlainCurrency(result.safeToSpendCents)}`,
      detail:
        "Even at the lowest point in this window you stay well ahead. That surplus could go " +
        "toward a goal or a debt instead of sitting still.",
      tone: "positive",
    });
  }

  return actions;
}

/** Whole-dollar formatting kept local so this module stays free of UI imports. */
function formatPlainCurrency(cents: number): string {
  return `$${Math.abs(Math.round(cents / 100)).toLocaleString("en-US")}`;
}

/** Strips punctuation and case so a hand-typed "SoFi" can be compared against a bank's
 *  "SOFI BANK PL DES:PL PYMT ID:T860... WEB". */
function normalizeDescription(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Shortest normalized description that's distinctive enough to substring-match on - below
 *  this, "a" or "co" would match half the statement. */
const MIN_MATCHABLE_LENGTH = 3;

/** Amounts this close are treated as the same charge - covers a payment that drifts by a few
 *  cents of interest between months. */
function amountsAreClose(a: number, b: number): boolean {
  const x = Math.abs(a);
  const y = Math.abs(b);
  return Math.abs(x - y) <= Math.max(100, Math.max(x, y) * 0.02);
}

/**
 * Whether a charge inferred from history is really the same thing as a bill the user already
 * scheduled, in which case projecting both would double-count it.
 *
 * Exact description equality alone isn't enough: people name their rule "SoFi" while the bank
 * writes "SOFI BANK PL DES:PL PYMT ID:T86083200 INDN:Tyler Fameli CO ID:3452499527 WEB". So a
 * near-identical amount plus a recognisable description overlap counts as a match.
 */
export function chargeMatchesRule(
  charge: { description: string; amount_cents: number },
  rule: { description: string; amount_cents: number }
): boolean {
  const a = normalizeDescription(charge.description);
  const b = normalizeDescription(rule.description);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;

  if (!amountsAreClose(charge.amount_cents, rule.amount_cents)) return false;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= MIN_MATCHABLE_LENGTH && longer.includes(shorter)) return true;

  // "SoFi Loan" vs "SoFi Bank PL…" share no containment but obviously refer to the same payee.
  const firstA = a.split(" ")[0];
  const firstB = b.split(" ")[0];
  return firstA.length >= MIN_MATCHABLE_LENGTH && firstA === firstB;
}
