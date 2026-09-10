import { getDb, getRecurringRulesForProfile } from "./db";
import { detectRecurringCharges } from "./recurringCharges";
import { detectedChargeToRule, chargeMatchesRule, expandOccurrences, type ForecastEvent, type ForecastRule } from "./forecast";
import type { RecurringCharge, RecurringRule } from "./types";
import type { ShapeTxn, ScheduledLike } from "./insights/shape";

/**
 * The scheduled bills and income for a profile, shared by the Plan forecast, the planned
 * summaries on Plan and Dashboard, and the insight engine, so every surface agrees on what
 * counts as planned. Kept apart from forecastData.ts so agent.ts can import it without a cycle
 * (forecastData imports agent for the debt payoff plan).
 */

export interface PlannedRules {
  /** Bills and income the user entered themselves. */
  rules: ForecastRule[];
  /** Charges inferred from history, excluding any that duplicate a user rule. */
  detected: ForecastRule[];
  hasIncomeRule: boolean;
  activeRules: RecurringRule[];
  detectedCharges: RecurringCharge[];
}

export async function getPlannedRules(profileId: number, detectedCharges?: RecurringCharge[]): Promise<PlannedRules> {
  const [ruleRows, charges] = await Promise.all([
    getRecurringRulesForProfile(profileId),
    detectedCharges ? Promise.resolve(detectedCharges) : detectRecurringCharges([profileId]),
  ]);
  const activeRules = ruleRows.filter((r) => r.active);
  const rules: ForecastRule[] = activeRules.map((r) => ({
    id: r.id,
    description: r.description,
    amount_cents: r.amount_cents,
    source: "rule",
    cadence: r.cadence,
    day_of_month: r.day_of_month,
    day_of_week: r.day_of_week,
    start_date: r.start_date,
    category_name: r.category_name ?? null,
    category_color: r.category_color ?? null,
  }));

  // A charge the user has already scheduled would otherwise be projected twice - matched
  // loosely, since a hand-typed "SoFi" and the bank's full ACH descriptor are the same bill.
  const detected: ForecastRule[] = charges
    .filter((c) => !activeRules.some((r) => chargeMatchesRule(c, r)))
    .map(detectedChargeToRule);

  return { rules, detected, hasIncomeRule: activeRules.some((r) => r.amount_cents > 0), activeRules, detectedCharges: charges };
}

/** Every scheduled deposit and bill falling inside [fromIso, toIso], for planned summaries. */
export async function getPlannedEvents(profileId: number, fromIso: string, toIso: string, includeDetected: boolean): Promise<ForecastEvent[]> {
  const planned = await getPlannedRules(profileId);
  const rules = includeDetected ? [...planned.rules, ...planned.detected] : planned.rules;
  // Date-only strings parse as UTC midnight; appending a local time keeps the day intact.
  return expandOccurrences(rules, new Date(`${fromIso}T00:00:00`), new Date(`${toIso}T00:00:00`));
}

/** Rows and schedules the "Fixed and flexible" instrument needs, summed across profiles. */
export interface FixedFlexibleInputs {
  txns: ShapeTxn[];
  bills: ScheduledLike[];
  detected: ScheduledLike[];
  /** The last three complete months, newest first; the caller keeps the ones with income. */
  candidateMonths: string[];
}

export async function getFixedFlexibleInputs(profileIds: number[], today: Date = new Date()): Promise<FixedFlexibleInputs> {
  const db = await getDb();
  const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const candidateMonths = [1, 2, 3].map((back) => monthKey(new Date(today.getFullYear(), today.getMonth() - back, 1)));
  const windowStart = `${candidateMonths[2]}-01`;
  const thisStart = `${monthKey(today)}-01`;

  const txns: ShapeTxn[] = [];
  const bills: ScheduledLike[] = [];
  const detected: ScheduledLike[] = [];
  for (const profileId of profileIds) {
    const [rows, planned] = await Promise.all([
      db.select<ShapeTxn[]>(
        `SELECT t.date, t.amount_cents, t.description, a.account_type, t.category_id
         FROM transactions t JOIN accounts a ON a.id=t.account_id
         WHERE t.profile_id=? AND a.excluded_from_insights=0 AND a.account_type!='loan'
           AND t.date>=? AND t.date<?`,
        [profileId, windowStart, thisStart]
      ),
      getPlannedRules(profileId),
    ]);
    txns.push(...rows);
    bills.push(...planned.activeRules.filter((r) => r.amount_cents < 0).map((r) => ({ description: r.description, amount_cents: r.amount_cents })));
    detected.push(...planned.detectedCharges.map((c) => ({ description: c.description, amount_cents: c.amount_cents })));
  }
  return { txns, bills, detected, candidateMonths };
}
