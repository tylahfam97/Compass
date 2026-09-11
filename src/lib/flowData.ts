import { getDb } from "./db";
import { toISODate } from "./forecast";
import { getPlannedRules } from "./plannedRules";
import type { ScheduledLike } from "./insights/shape";
import type { FlowTxn } from "./flows";

/**
 * Rows for The Chart: one month of checking and card activity, padded three days either side so
 * a transfer that posts across the month boundary still finds its other leg, plus the user's
 * scheduled bills and Compass's detected charges so a rent payment is named by its rule. Kept
 * apart from flows.ts so the graph maths stays pure and unit-testable.
 */
export interface MoneyFlowInputs {
  txns: FlowTxn[];
  bills: ScheduledLike[];
  detected: ScheduledLike[];
}

const PAD_DAYS = 3;

export async function getMoneyFlowInputs(profileId: number, month: string): Promise<MoneyFlowInputs> {
  const db = await getDb();
  const [y, m] = month.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  start.setDate(start.getDate() - PAD_DAYS);
  const end = new Date(y, m, 1);
  end.setDate(end.getDate() + PAD_DAYS);

  const [txns, planned] = await Promise.all([
    db.select<FlowTxn[]>(
      `SELECT t.*, a.name as account_name, a.account_type, c.name as category_name, c.color as category_color
       FROM transactions t
       JOIN accounts a ON a.id=t.account_id
       LEFT JOIN categories c ON c.id=t.category_id
       WHERE t.profile_id=? AND t.date>=? AND t.date<? AND a.account_type IN ('checking','credit')
       ORDER BY t.date ASC, t.id ASC`,
      [profileId, toISODate(start), toISODate(end)]
    ),
    getPlannedRules(profileId),
  ]);

  return {
    txns,
    bills: planned.activeRules.filter((r) => r.amount_cents < 0).map((r) => ({ description: r.description, amount_cents: r.amount_cents })),
    detected: planned.detectedCharges.map((c) => ({ description: c.description, amount_cents: c.amount_cents })),
  };
}
