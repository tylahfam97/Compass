import type { ForecastWindowMode } from "./forecast";

export type SpendPer = "day" | "month";

/** How the projection is drawn. The line chart stays the default. */
export type PlanView = "line" | "map" | "calendar";
export const PLAN_VIEWS: readonly PlanView[] = ["line", "map", "calendar"];

/** Optional Plan sections the user can tuck away (the forecast itself always stays). */
export type PlanPanel = "actions" | "payoff" | "upcoming";
export const PLAN_PANELS: readonly PlanPanel[] = ["actions", "upcoming", "payoff"];

export interface PlanScenario {
  version: 2;
  window: ForecastWindowMode;
  buffer: number;
  detected: boolean;
  typical: boolean;
  /** Change to everyday spending, signed (negative = spend less), per day or per month. */
  spend: { cents: number; per: SpendPer };
  /** Extra income per month, spread evenly over the month. */
  income: number;
  /** Date of the scheduled paycheck to leave out, or "". Bound to that one date so a saved
   *  skip never moves on to the following paycheck once this one has passed. */
  skipPay: string;
  /** One-off money out ("out", a purchase) or in ("in") on a date. */
  purchase: { date: string; amountCents: number; kind: "out" | "in" };
  /** Layout preferences (#123). Not part of the what-if, so Reset leaves them alone. */
  view: PlanView;
  hidden: PlanPanel[];
  /** Dots on the line chart for each day with a scheduled bill or deposit. */
  markers: boolean;
}

/** The ranges the sliders used before #123. They now apply only when no liquid cash is on
 *  file (no checking balance recorded, or the balance is zero or overdrawn), so a slider is
 *  never left with an empty or inverted range. */
export const SPEND_LIMIT: Record<SpendPer, { max: number; step: number }> = {
  day: { max: 20_000, step: 500 },
  month: { max: 200_000, step: 5_000 },
};
export const INCOME_LIMIT = { max: 500_000, step: 5_000 };
export const BUFFER_LIMIT = { max: 200_000, step: 5_000 };

/** Largest amount a saved scenario may hold ($1,000,000). A sanity bound against corrupt
 *  storage only: the live ranges come from `scenarioLimits`, and a saved value above today's
 *  range is clamped for display without being rewritten. */
export const SCENARIO_MAX_CENTS = 100_000_000;

export interface SliderLimit { min: number; max: number; step: number }

export interface ScenarioLimits {
  /** Liquid cash the ranges come from: the checking/savings balances the forecast starts
   *  from. Null when no balance is on file. */
  liquidCents: number | null;
  /** True when there is no positive liquid cash, so the pre-#123 ranges apply. */
  fallback: boolean;
  /** Keep in reserve: 0 up to the liquid cash. */
  buffer: SliderLimit;
  /** Spending change: cuts down to typical spending, increases up to the flow scale. */
  spend: Record<SpendPer, SliderLimit>;
  /** Extra income per month: up to the flow scale. */
  income: SliderLimit;
  /** What the spending/income ranges are measured against: the larger of liquid cash and
   *  scheduled monthly income. */
  flowScaleCents: number;
}

const NICE_STEPS = [100, 200, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

/** A round step giving at most ~100 positions across `range`, so a drag or arrow key moves a
 *  sensible amount whether the range is $40 or $40,000. */
export function niceStep(range: number): number {
  const target = range / 100;
  return NICE_STEPS.find((s) => s >= target) ?? NICE_STEPS[NICE_STEPS.length - 1];
}

function upTo(cents: number): SliderLimit {
  const step = niceStep(cents);
  // Floored to the step so the thumb can reach the top; never less than one step.
  return { min: 0, max: Math.max(step, Math.floor(cents / step) * step), step };
}

/** Rounds a cut bound away from zero so the whole of typical spending can be cut. */
function cutFloor(typicalCents: number, step: number): number {
  return typicalCents > 0 ? -Math.ceil(typicalCents / step) * step : 0;
}

/**
 * Slider ranges tied to the money actually on hand (#123): the cushion tops out at the liquid
 * cash the forecast starts from (checking and savings only - never credit, investments or
 * loans); spending and income changes are monthly flows, so they span the larger of that cash
 * and the scheduled monthly income. With no positive liquid cash on file the pre-#123 ranges
 * apply instead, so every control stays usable and the page says why.
 */
export function scenarioLimits(input: { liquidCents: number | null; monthlyIncomeCents?: number; typicalDailyCents?: number }): ScenarioLimits {
  const liquid = input.liquidCents;
  const typicalDaily = Math.max(0, Math.round(input.typicalDailyCents ?? 0));
  const usable = liquid !== null && liquid >= 100;
  const flowScale = Math.max(usable ? liquid : 0, Math.max(0, Math.round(input.monthlyIncomeCents ?? 0)));

  const buffer = usable ? upTo(liquid) : { min: 0, ...BUFFER_LIMIT };
  const flows = flowScale >= 100;
  const month = flows ? upTo(flowScale) : { min: 0, ...SPEND_LIMIT.month };
  const day = flows ? upTo(Math.max(100, Math.round(flowScale / 30))) : { min: 0, ...SPEND_LIMIT.day };
  // Typical spending is per day; a month of it is the most a monthly cut can remove.
  month.min = cutFloor(typicalDaily * 31, month.step);
  day.min = cutFloor(typicalDaily, day.step);
  const income = flows ? upTo(flowScale) : { min: 0, ...INCOME_LIMIT };

  return { liquidCents: liquid, fallback: !usable, buffer, spend: { day, month }, income, flowScaleCents: flowScale };
}

/** Keeps a saved value inside today's range for display and projection, without rewriting
 *  what was saved (a balance that dips for a day shouldn't erase the user's choice). */
export function clampToLimit(value: number, limit: SliderLimit): number {
  return Math.min(limit.max, Math.max(limit.min, value));
}

function cents(value: unknown, max = SCENARIO_MAX_CENTS): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : 0;
}

function validDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

type StoredScenario = Partial<Omit<PlanScenario, "version" | "spend" | "purchase" | "hidden">> & {
  version?: number;
  /** v1: extra spending stored as one total spread over the window. */
  extra?: number;
  spend?: Partial<PlanScenario["spend"]>;
  purchase?: Partial<PlanScenario["purchase"]>;
  hidden?: unknown;
};

export function validateScenario(value: StoredScenario): PlanScenario {
  const date = value.purchase?.date ?? "";
  const per: SpendPer = value.spend?.per === "day" ? "day" : "month";
  const spendCents = value.spend?.cents;
  // v1 kept extra spending as one total for the window; its nearest v2 meaning is per month.
  const spend = value.spend
    ? (typeof spendCents === "number" && Number.isSafeInteger(spendCents) && Math.abs(spendCents) <= SCENARIO_MAX_CENTS ? spendCents : 0)
    : Math.min(SPEND_LIMIT.month.max, cents(value.extra));
  const storedHidden = Array.isArray(value.hidden) ? value.hidden : [];
  return {
    version: 2,
    window: ["month", "paycheck", "nextMonth"].includes(value.window ?? "") ? value.window! : "month",
    buffer: cents(value.buffer),
    detected: value.detected !== false, typical: value.typical === true,
    spend: { cents: spend, per },
    income: cents(value.income),
    skipPay: validDate(value.skipPay) ? value.skipPay : "",
    purchase: { date: validDate(date) ? date : "", amountCents: cents(value.purchase?.amountCents), kind: value.purchase?.kind === "in" ? "in" : "out" },
    view: value.view && PLAN_VIEWS.includes(value.view) ? value.view : "line",
    hidden: PLAN_PANELS.filter((panel) => storedHidden.includes(panel)),
    markers: value.markers !== false,
  };
}

export function loadScenario(profileId: number): PlanScenario {
  try {
    const stored = localStorage.getItem(`compass_plan_scenario_${profileId}`);
    if (stored) return validateScenario(JSON.parse(stored) ?? {});
    if (!localStorage.getItem("compass_plan_migrated")) {
      const scenario = validateScenario({
        window: localStorage.getItem("compass_plan_window") as ForecastWindowMode,
        extra: Number(localStorage.getItem("compass_plan_extra")),
        buffer: Number(localStorage.getItem("compass_plan_buffer")),
        detected: localStorage.getItem("compass_plan_detected") !== "0",
        typical: localStorage.getItem("compass_plan_baseline") === "1",
      });
      localStorage.setItem(`compass_plan_scenario_${profileId}`, JSON.stringify(scenario));
      localStorage.setItem("compass_plan_migrated", "1");
      return scenario;
    }
  } catch { return validateScenario({}); }
  return validateScenario({});
}

export function saveScenario(profileId: number, scenario: PlanScenario): void {
  try { localStorage.setItem(`compass_plan_scenario_${profileId}`, JSON.stringify(validateScenario(scenario))); } catch { return; }
}
