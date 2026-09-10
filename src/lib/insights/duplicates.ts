import { merchantKey } from "../merchants";

/** A transaction row with enough to spot a charge posted twice. */
export interface DupTxn {
  id: number;
  account_id: number;
  date: string;
  description: string;
  amount_cents: number;
}

export interface DuplicateCharge {
  key: string;
  description: string;
  date: string;
  amountCents: number;
  accountId: number;
  ids: number[];
}

export interface DuplicateOptions {
  /** Only pairs dated on or after this day are reported; earlier rows still feed the frequency guard. */
  sinceIso: string;
  /** Merchant keys that are known recurring charges, never reported. */
  excludeKeys?: Set<string>;
  minCents?: number;
  /** A merchant seen more often than this across `rows` is a habit (transit, coffee), not a double charge. */
  maxMerchantTxns?: number;
  /** Rows to leave out of pairing (ATM withdrawals, tips, cheap lunches); they still count toward frequency. */
  skip?: (row: DupTxn) => boolean;
}

/**
 * Two identical charges from one merchant on one account on the same calendar day. Same-day is
 * deliberate: a repeat the next day is usually a real second purchase, while a duplicate
 * authorization posts twice on the same date.
 */
export function findDuplicateCharges(rows: DupTxn[], options: DuplicateOptions): DuplicateCharge[] {
  const { sinceIso, excludeKeys = new Set<string>(), minCents = 2000, maxMerchantTxns = 6, skip } = options;
  const perMerchant = new Map<string, number>();
  const groups = new Map<string, DupTxn[]>();

  for (const r of rows) {
    if (r.amount_cents >= 0) continue;
    const key = merchantKey(r.description);
    if (!key) continue;
    perMerchant.set(key, (perMerchant.get(key) ?? 0) + 1);
    if (r.date < sinceIso || Math.abs(r.amount_cents) < minCents || skip?.(r)) continue;
    const groupKey = `${key}|${r.account_id}|${r.date}|${r.amount_cents}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(r);
  }

  const out: DuplicateCharge[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const key = merchantKey(list[0].description);
    if (excludeKeys.has(key)) continue;
    if ((perMerchant.get(key) ?? 0) > maxMerchantTxns) continue;
    out.push({
      key,
      description: list[0].description,
      date: list[0].date,
      amountCents: Math.abs(list[0].amount_cents),
      accountId: list[0].account_id,
      ids: list.map((t) => t.id),
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.amountCents - a.amountCents);
}

export interface FrequentMerchant {
  key: string;
  description: string;
  count: number;
  totalCents: number;
}

/** Merchants visited at least `minCount` times in `rows`, largest total first. */
export function findFrequentMerchants(
  rows: { description: string; amount_cents: number }[],
  options: { minCount?: number; minTotalCents?: number } = {}
): FrequentMerchant[] {
  const { minCount = 6, minTotalCents = 4000 } = options;
  const groups = new Map<string, FrequentMerchant>();
  for (const r of rows) {
    if (r.amount_cents >= 0) continue;
    const key = merchantKey(r.description);
    if (!key) continue;
    const g = groups.get(key) ?? { key, description: r.description, count: 0, totalCents: 0 };
    g.count++;
    g.totalCents += Math.abs(r.amount_cents);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.count >= minCount && g.totalCents >= minTotalCents)
    .sort((a, b) => b.totalCents - a.totalCents);
}
