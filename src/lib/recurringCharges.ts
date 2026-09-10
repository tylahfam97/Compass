import { getDb } from "./db";
import type { RecurringCharge } from "./types";
import { getHiddenChargeKeys, chargeKey } from "./hiddenCharges";
import { findRecurringStreak, patternLabelFor, amountHistoryOf, type RecurringRow } from "./recurringDetection";

/** A charge that hasn't been seen for this long is treated as cancelled rather than recurring.
 *  Without this, a subscription that ran for a few months and stopped keeps its old streak
 *  forever and goes on being billed in the forecast and listed as a live subscription. It comes
 *  back on its own the moment a new transaction matching it is imported. */
const RECURRING_STALE_AFTER_MONTHS = 2;

/** Detects recurring charges (subscriptions, bills) across the given profiles - grouped by
 *  exact description, then matched on a day-of-month or "Nth weekday of month" cadence with a
 *  currently-active streak of 2+ consecutive months (see `findRecurringStreak`). Charges last
 *  seen more than RECURRING_STALE_AFTER_MONTHS ago, any the user has explicitly hidden, and
 *  anything on an account excluded from insights are left out. Returns every match sorted by
 *  amount descending - the caller decides how much of the list to show. */
export async function detectRecurringCharges(profileIds: number[], monthsBack = 12): Promise<RecurringCharge[]> {
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");
  const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const start = (() => { const d = new Date(); d.setMonth(d.getMonth() - monthsBack); d.setDate(1); return localIso(d); })();
  const staleBefore = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - RECURRING_STALE_AFTER_MONTHS);
    return localIso(d);
  })();
  const hidden = getHiddenChargeKeys(profileIds);

  const rows = await db.select<RecurringRow[]>(
    `SELECT t.description, t.amount_cents, t.date, c.name as category_name, c.color as category_color
     FROM transactions t
     JOIN accounts a ON a.id=t.account_id
     LEFT JOIN categories c ON t.category_id=c.id
     WHERE t.profile_id IN (${ph}) AND t.amount_cents<0 AND t.date>=? AND a.excluded_from_insights=0
       AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
     ORDER BY t.description, t.date`,
    [...profileIds, start]
  );

  const groups = new Map<string, RecurringRow[]>();
  for (const r of rows) {
    const key = r.description.trim().toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const results: RecurringCharge[] = [];
  for (const groupRows of groups.values()) {
    const streak = findRecurringStreak(groupRows);
    if (!streak) continue;
    const anchor = streak.txns[streak.txns.length - 1];
    if (anchor.date < staleBefore) continue;
    if (hidden.has(chargeKey(anchor.description))) continue;
    const first = streak.txns[0];
    const amountHistory = amountHistoryOf(streak);
    const previous = amountHistory.length >= 2 ? amountHistory[amountHistory.length - 2] : null;
    results.push({
      description: anchor.description,
      amount_cents: anchor.amount_cents,
      month_count: streak.txns.length,
      first_seen: first.date,
      last_seen: anchor.date,
      category_name: anchor.category_name,
      category_color: anchor.category_color,
      patternLabel: patternLabelFor(anchor, streak.mode),
      amountHistory,
      previousAmountCents: previous !== null && previous !== Math.abs(anchor.amount_cents) ? previous : null,
    });
  }

  results.sort((a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents));
  return results;
}
