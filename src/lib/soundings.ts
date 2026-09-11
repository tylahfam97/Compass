/**
 * Soundings: net worth read as depth. A sounding is one month's net worth; the waterline is
 * zero. From the trailing months this module works out the pace (cents per month) and, when
 * the household is under water, the month it clears zero at that pace. Pure module, no DB.
 */

export interface SoundingPoint {
  /** "YYYY-MM" */
  month: string;
  netWorthCents: number;
  liquidCents: number;
  investmentCents: number;
  /** Credit card balances, stored <= 0. */
  debtCents: number;
  /** Loan balances, stored <= 0. */
  loanDebtCents: number;
}

export type Crossing =
  | { kind: "above"; sinceMonth: string | null }
  | { kind: "projected"; month: string; monthsAway: number }
  | { kind: "distant"; month: string; monthsAway: number }
  | { kind: "sinking" }
  | { kind: "unknown" };

export interface Sounding {
  /** History with the empty months before the first recorded balance removed. */
  points: SoundingPoint[];
  latest: SoundingPoint | null;
  changeMonthCents: number | null;
  changeYearCents: number | null;
  /** Least-squares slope of net worth over the trailing window, in cents per month. */
  paceCentsPerMonth: number | null;
  /** Months the pace was measured over. */
  paceMonths: number;
  crossing: Crossing;
  /** Straight-line projection from the latest sounding to the waterline, one point per month. */
  projection: { month: string; netWorthCents: number }[];
}

export interface SoundingOptions {
  /** Trailing months used to measure the pace. */
  window?: number;
  /** Beyond this many months a crossing is "distant" rather than a date to plan around. */
  distantMonths?: number;
}

const DEFAULTS: Required<SoundingOptions> = { window: 6, distantMonths: 120 };

/** Under a dollar a month is noise, not a pace. */
const MIN_PACE_CENTS = 100;

export function addMonths(ym: string, k: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + k;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLong(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function monthShort(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

/** One recorded balance for one account on one date. */
export interface BalanceObservation {
  accountId: number;
  /** ISO date, "YYYY-MM-DD". */
  date: string;
  valueCents: number;
  kind: "checking" | "investment" | "credit" | "loan";
}

export interface MonthCutoff {
  /** "YYYY-MM" */
  month: string;
  /** Inclusive ISO date the month's sounding is taken at. */
  cutoff: string;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const leap = m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0);
  const day = leap ? 29 : DAYS_IN_MONTH[m - 1];
  return `${ym}-${String(day).padStart(2, "0")}`;
}

/**
 * The trailing month ends to take soundings at, oldest first. The newest one stops at today
 * rather than a future month end, so the latest reading is never dated ahead of the data.
 */
export function monthCutoffs(todayIso: string, months: number): MonthCutoff[] {
  const currentMonth = todayIso.slice(0, 7);
  const out: MonthCutoff[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const month = addMonths(currentMonth, -i);
    out.push({ month, cutoff: i === 0 ? todayIso : lastDayOfMonth(month) });
  }
  return out;
}

/**
 * Rolls a flat list of recorded balances into one sounding per month, in a single pass.
 *
 * Each account contributes its most recent balance at or before the month's cutoff, matching
 * `computeNetWorth` exactly, so the history and the live net-worth figure can never disagree.
 * Observations must already be ordered oldest first; ties on a date resolve to the later row,
 * which is why the caller orders by date then id.
 */
export function buildSoundingHistory(observations: BalanceObservation[], months: MonthCutoff[]): SoundingPoint[] {
  const latest = new Map<number, BalanceObservation>();
  let cursor = 0;
  return months.map((m) => {
    while (cursor < observations.length && observations[cursor].date <= m.cutoff) {
      latest.set(observations[cursor].accountId, observations[cursor]);
      cursor++;
    }
    let liquidCents = 0, investmentCents = 0, debtCents = 0, loanDebtCents = 0;
    for (const o of latest.values()) {
      if (o.kind === "checking") liquidCents += o.valueCents;
      else if (o.kind === "investment") investmentCents += o.valueCents;
      else if (o.kind === "credit") debtCents += o.valueCents;
      else loanDebtCents += o.valueCents;
    }
    return {
      month: m.month,
      liquidCents,
      investmentCents,
      debtCents,
      loanDebtCents,
      netWorthCents: liquidCents + investmentCents + debtCents + loanDebtCents,
    };
  });
}

function isEmpty(p: SoundingPoint): boolean {
  return p.liquidCents === 0 && p.investmentCents === 0 && p.debtCents === 0 && p.loanDebtCents === 0;
}

/** Slope of a least-squares line through (0, v0), (1, v1), ... in value units per step. */
export function leastSquaresSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function soundings(history: SoundingPoint[], opts: SoundingOptions = {}): Sounding {
  const { window, distantMonths } = { ...DEFAULTS, ...opts };
  const firstIdx = history.findIndex((p) => !isEmpty(p));
  const points = firstIdx === -1 ? [] : history.slice(firstIdx);
  const latest = points.length > 0 ? points[points.length - 1] : null;

  if (!latest) {
    return { points, latest: null, changeMonthCents: null, changeYearCents: null, paceCentsPerMonth: null, paceMonths: 0, crossing: { kind: "unknown" }, projection: [] };
  }

  const prev = points.length >= 2 ? points[points.length - 2] : null;
  const yearAgo = points.length >= 13 ? points[points.length - 13] : null;
  const changeMonthCents = prev ? latest.netWorthCents - prev.netWorthCents : null;
  const changeYearCents = yearAgo ? latest.netWorthCents - yearAgo.netWorthCents : null;

  const trailing = points.slice(-window);
  const paceMonths = trailing.length;
  let paceCentsPerMonth: number | null = null;
  if (trailing.length >= 3) {
    const slope = leastSquaresSlope(trailing.map((p) => p.netWorthCents));
    paceCentsPerMonth = Math.abs(slope) < MIN_PACE_CENTS ? 0 : Math.round(slope);
  }

  let crossing: Crossing;
  const projection: { month: string; netWorthCents: number }[] = [];

  if (latest.netWorthCents >= 0) {
    // Walk back through the run of months at or above the waterline.
    let since: string | null = null;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].netWorthCents < 0) break;
      since = points[i].month;
    }
    crossing = { kind: "above", sinceMonth: since === points[0].month ? null : since };
  } else if (paceCentsPerMonth === null) {
    crossing = { kind: "unknown" };
  } else if (paceCentsPerMonth <= 0) {
    crossing = { kind: "sinking" };
  } else {
    const monthsAway = Math.ceil(-latest.netWorthCents / paceCentsPerMonth);
    const month = addMonths(latest.month, monthsAway);
    crossing = monthsAway > distantMonths ? { kind: "distant", month, monthsAway } : { kind: "projected", month, monthsAway };
    for (let k = 1; k <= monthsAway; k++) {
      projection.push({ month: addMonths(latest.month, k), netWorthCents: Math.min(0, latest.netWorthCents + paceCentsPerMonth * k) });
    }
  }

  return { points, latest, changeMonthCents, changeYearCents, paceCentsPerMonth, paceMonths, crossing, projection };
}

function dollarsWhole(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.abs(cents) / 100);
}

/** One plain sentence for the instrument. No dashes, arrows or exclamation marks. */
export function describeSounding(s: Sounding): string {
  if (!s.latest) return "Import a statement to take the first sounding.";
  const paceWord = s.paceCentsPerMonth == null ? null : s.paceCentsPerMonth >= 0 ? "up" : "down";
  const pace = s.paceCentsPerMonth == null ? "" : `${paceWord} ${dollarsWhole(s.paceCentsPerMonth)} a month over the last ${s.paceMonths} months`;
  switch (s.crossing.kind) {
    case "above":
      return s.crossing.sinceMonth
        ? `Above water since ${monthLong(s.crossing.sinceMonth)}${pace ? `, ${pace}` : ""}.`
        : `Above water for the whole recorded history${pace ? `, ${pace}` : ""}.`;
    case "projected":
      return `At this pace, ${pace}, net worth clears zero around ${monthLong(s.crossing.month)}.`;
    case "distant":
      return `At this pace, ${pace}, clearing zero is more than ${Math.floor(s.crossing.monthsAway / 12)} years out.`;
    case "sinking":
      return s.paceCentsPerMonth === 0
        ? `Holding steady over the last ${s.paceMonths} months, not yet climbing toward the waterline.`
        : `Net worth is ${pace}. It is not on course to clear zero.`;
    default:
      return "A few more months of statements will show the pace.";
  }
}
