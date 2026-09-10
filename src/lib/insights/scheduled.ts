import { expandOccurrences, chargeMatchesRule, type ForecastEvent, type ForecastRule } from "../forecast";

/**
 * Insights about the bills and paychecks the user scheduled in Plan. Scheduled truth beats
 * inferred truth: when a rule exists, these functions use it and never guess from history.
 */

export interface ScheduledTxn {
  date: string;
  description: string;
  amount_cents: number;
  account_id?: number;
}

/** A rule may name the account it posts to; when it does, only that account's rows can satisfy it. */
export type ScheduledRule = ForecastRule & { accountId?: number | null };

export interface MissingScheduled {
  rule: ScheduledRule;
  expectedDate: string;
  kind: "bill" | "income";
}

export interface MissingScheduledOptions {
  /** How far back to look for expected occurrences. */
  lookbackDays: number;
  /** Days after the expected date before a missing charge is worth mentioning. */
  graceDays: number;
  /** A matching transaction may post this many days early. */
  earlyDays: number;
  /** ...or this many days late before it stops counting as the same occurrence. */
  lateDays: number;
}

const DEFAULTS: MissingScheduledOptions = { lookbackDays: 35, graceDays: 3, earlyDays: 5, lateDays: 10 };

function toLocal(iso: string): Date { return new Date(`${iso}T00:00:00`); }
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(isoDate: string, n: number): string {
  const d = toLocal(isoDate);
  d.setDate(d.getDate() + n);
  return iso(d);
}
function daysBetween(a: string, b: string): number {
  return Math.round((toLocal(b).getTime() - toLocal(a).getTime()) / 86_400_000);
}

/**
 * Scheduled occurrences that should have posted by now but have no matching transaction.
 *
 * `coverageThroughIso` is the newest transaction date the profile has on enabled accounts: an
 * occurrence is only "missing" when the imported data actually reaches past it, otherwise the
 * user simply has not imported that week yet and the right message is "import", not "missed".
 */
export function findMissingScheduled(
  rules: ScheduledRule[],
  txns: ScheduledTxn[],
  todayIso: string,
  coverageThroughIso: string,
  options: Partial<MissingScheduledOptions> & { coverageByAccount?: Map<number, string> } = {}
): MissingScheduled[] {
  const opts = { ...DEFAULTS, ...options };
  const from = addDays(todayIso, -opts.lookbackDays);
  const to = addDays(todayIso, -opts.graceDays);
  if (to < from) return [];

  const results: MissingScheduled[] = [];
  for (const rule of rules) {
    if (rule.amount_cents === 0 || rule.description.replace(/[^a-z0-9]/gi, "").length < 3) continue;
    const occurrences = expandOccurrences([rule], toLocal(from), toLocal(to)).filter((e) => e.date >= rule.start_date);
    if (occurrences.length === 0) continue;

    const wantNegative = rule.amount_cents < 0;
    const candidates = txns.filter((t) =>
      (t.amount_cents < 0) === wantNegative && t.amount_cents !== 0 &&
      (rule.accountId == null || t.account_id == null || t.account_id === rule.accountId) &&
      chargeMatchesRule({ description: t.description, amount_cents: t.amount_cents }, rule)
    );
    const used = new Set<number>();
    const coverage = (rule.accountId != null && options.coverageByAccount?.get(rule.accountId)) || coverageThroughIso;

    for (const occ of occurrences) {
      // Not enough data to know yet.
      if (coverage < addDays(occ.date, opts.graceDays)) continue;
      const windowStart = addDays(occ.date, -opts.earlyDays);
      const windowEnd = addDays(occ.date, opts.lateDays);
      let best = -1;
      let bestDistance = Infinity;
      candidates.forEach((t, i) => {
        if (used.has(i) || t.date < windowStart || t.date > windowEnd) return;
        const distance = Math.abs(daysBetween(t.date, occ.date));
        if (distance < bestDistance) { bestDistance = distance; best = i; }
      });
      if (best >= 0) used.add(best);
      else results.push({ rule, expectedDate: occ.date, kind: wantNegative ? "bill" : "income" });
    }
  }
  return results.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
}

/** Bills (money out) among planned events dated within the next `days` days, today included. */
export function billsDueWithin(events: ForecastEvent[], todayIso: string, days: number): ForecastEvent[] {
  const end = addDays(todayIso, days);
  return events
    .filter((e) => e.amountCents < 0 && e.date >= todayIso && e.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The next deposit among planned events, today or later. */
export function nextIncomeEvent(events: ForecastEvent[], todayIso: string): ForecastEvent | null {
  return events.filter((e) => e.amountCents > 0 && e.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
}

export { addDays as addDaysIso, daysBetween as daysBetweenIso };
