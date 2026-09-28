import { getDb } from "./db";
import { expandOccurrences } from "./forecast";
import { getPlannedRules } from "./plannedRules";
import type { ScheduledLike } from "./insights/shape";
import { addDaysIso, isoToDate, type Deposit, type PayCycleTxn } from "./payCycle";

/**
 * Rows for The Watch: the user's scheduled paydays expanded around today, sizeable deposits
 * for rhythm detection when nothing is scheduled, and the last few months of checking and
 * card activity to read everyday spending cycle by cycle.
 */
export interface WatchInputs {
  plannedPaydays: string[];
  deposits: Deposit[];
  txns: PayCycleTxn[];
  bills: ScheduledLike[];
  detected: ScheduledLike[];
}

const HISTORY_DAYS = 200;
const LOOKAHEAD_DAYS = 60;

export async function getWatchInputs(profileId: number, today: string): Promise<WatchInputs> {
  const db = await getDb();
  const from = addDaysIso(today, -HISTORY_DAYS);
  const to = addDaysIso(today, LOOKAHEAD_DAYS);

  const [planned, deposits, txns] = await Promise.all([
    getPlannedRules(profileId),
    db.select<Deposit[]>(
      `SELECT t.date, t.amount_cents, t.description FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id=? AND a.account_type NOT IN ('credit','loan') AND a.excluded_from_insights=0
         AND t.amount_cents>=50000 AND t.date>=? AND t.date<=?
         AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
       ORDER BY t.date ASC`,
      [profileId, from, today]
    ),
    db.select<PayCycleTxn[]>(
      `SELECT t.date, t.amount_cents, t.category_id, c.name as category_name, a.account_type, t.description
       FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id
       WHERE t.profile_id=? AND a.account_type IN ('checking','credit') AND a.excluded_from_insights=0
         AND t.amount_cents<0 AND t.date>=? AND t.date<=?`,
      [profileId, from, today]
    ),
  ]);

  const incomeRules = planned.rules.filter((r) => r.amount_cents > 0);
  const plannedPaydays = expandOccurrences(incomeRules, isoToDate(from), isoToDate(to)).map((e) => e.date);

  return {
    plannedPaydays,
    deposits,
    txns,
    bills: planned.activeRules.filter((r) => r.amount_cents < 0).map((r) => ({ description: r.description, amount_cents: r.amount_cents })),
    detected: planned.detectedCharges.map((c) => ({ description: c.description, amount_cents: c.amount_cents })),
  };
}
