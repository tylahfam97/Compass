import type { ForecastWindowMode } from "./forecast";

export interface PlanScenario {
  version: 1;
  window: ForecastWindowMode;
  extra: number;
  buffer: number;
  detected: boolean;
  typical: boolean;
  purchase: { date: string; amountCents: number };
}

const defaultScenario: PlanScenario = {
  version: 1, window: "month", extra: 0, buffer: 0, detected: true, typical: false,
  purchase: { date: "", amountCents: 0 },
};

function cents(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000 ? value : 0;
}

export function validateScenario(value: Partial<PlanScenario>): PlanScenario {
  const date = value.purchase?.date ?? "";
  const parsed = new Date(`${date}T12:00:00Z`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  return {
    version: 1,
    window: ["month", "paycheck", "nextMonth"].includes(value.window ?? "") ? value.window! : "month",
    extra: Math.min(200_000, cents(value.extra)), buffer: Math.min(200_000, cents(value.buffer)),
    detected: value.detected !== false, typical: value.typical === true,
    purchase: { date: validDate ? date : "", amountCents: cents(value.purchase?.amountCents) },
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
  } catch { return { ...defaultScenario }; }
  return { ...defaultScenario };
}

export function saveScenario(profileId: number, scenario: PlanScenario): void {
  try { localStorage.setItem(`compass_plan_scenario_${profileId}`, JSON.stringify(validateScenario(scenario))); } catch { return; }
}