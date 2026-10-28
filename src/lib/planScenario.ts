import type { ForecastWindowMode } from "./forecast";

export type SpendPer = "day" | "month";

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
}

/** Slider limits per unit, shared by the controls and validation. */
export const SPEND_LIMIT: Record<SpendPer, { max: number; step: number }> = {
  day: { max: 20_000, step: 500 },
  month: { max: 200_000, step: 5_000 },
};
export const INCOME_LIMIT = { max: 500_000, step: 5_000 };

function cents(value: unknown, max = 100_000_000): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : 0;
}

function validDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

type StoredScenario = Partial<Omit<PlanScenario, "version" | "spend" | "purchase">> & {
  version?: number;
  /** v1: extra spending stored as one total spread over the window. */
  extra?: number;
  spend?: Partial<PlanScenario["spend"]>;
  purchase?: Partial<PlanScenario["purchase"]>;
};

export function validateScenario(value: StoredScenario): PlanScenario {
  const date = value.purchase?.date ?? "";
  const per: SpendPer = value.spend?.per === "day" ? "day" : "month";
  const spendCents = value.spend?.cents;
  // v1 kept extra spending as one total for the window; its nearest v2 meaning is per month.
  const spend = value.spend
    ? (typeof spendCents === "number" && Number.isSafeInteger(spendCents) && Math.abs(spendCents) <= SPEND_LIMIT[per].max ? spendCents : 0)
    : Math.min(SPEND_LIMIT.month.max, cents(value.extra));
  return {
    version: 2,
    window: ["month", "paycheck", "nextMonth"].includes(value.window ?? "") ? value.window! : "month",
    buffer: Math.min(200_000, cents(value.buffer)),
    detected: value.detected !== false, typical: value.typical === true,
    spend: { cents: spend, per },
    income: cents(value.income, INCOME_LIMIT.max),
    skipPay: validDate(value.skipPay) ? value.skipPay : "",
    purchase: { date: validDate(date) ? date : "", amountCents: cents(value.purchase?.amountCents), kind: value.purchase?.kind === "in" ? "in" : "out" },
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
