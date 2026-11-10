import { merchantKey } from "../merchants";
import { classifyExpense, isExpenseTxn, type ScheduledLike, type ShapeTxn } from "./shape";

/**
 * Two patterns the rest of the engine does not look for. Pure: the engine feeds them rows it
 * already loaded and decides the wording.
 */

// ── The stretch before payday ────────────────────────────────────────────────

/** Income landing today or tomorrow needs no pacing; beyond two weeks the schedule is a guess. */
export const CUSHION_MIN_DAYS = 2;
export const CUSHION_MAX_DAYS = 14;
/** Fires when the money free per day is under this share of the usual daily pace. */
export const CUSHION_TIGHT_RATIO = 0.75;

export interface CushionInput {
  /** Checking balance on file. The caller guarantees it is recent. */
  balanceCents: number;
  /** Days from today until the next scheduled income: today counts, the income day does not. */
  daysToIncome: number;
  /** Scheduled bills due before that income, as a positive total. */
  billsDueCents: number;
  /** Usual everyday spending out of checking per day, scheduled bills excluded. */
  dailySpendCents: number;
}

export interface Cushion {
  days: number;
  /** What is left of the balance once the scheduled bills are paid. */
  freeCents: number;
  perDayCents: number;
  /** How far the free money falls short of the usual pace over the same days. */
  gapCents: number;
}

/**
 * The balance can cover every scheduled bill and still be thin: bills are projected, everyday
 * spending is not. Returns the per-day figure when it is well under the usual pace, and null
 * when there is nothing to say (income is close, the pace is unknown, there is room) or when
 * the bills alone overdraw the account, which the shortfall warning already owns.
 */
export function paydayCushion(input: CushionInput): Cushion | null {
  const { balanceCents, daysToIncome, billsDueCents, dailySpendCents } = input;
  if (daysToIncome < CUSHION_MIN_DAYS || daysToIncome > CUSHION_MAX_DAYS) return null;
  if (dailySpendCents <= 0) return null;
  const freeCents = balanceCents - billsDueCents;
  if (freeCents < 0) return null;
  const perDayCents = Math.floor(freeCents / daysToIncome);
  if (perDayCents >= dailySpendCents * CUSHION_TIGHT_RATIO) return null;
  return { days: daysToIncome, freeCents, perDayCents, gapCents: dailySpendCents * daysToIncome - freeCents };
}

// ── Small purchases ──────────────────────────────────────────────────────────

/** A purchase under this is "small". */
export const SMALL_PURCHASE_MAX_CENTS = 1000;

export interface SmallPurchases {
  count: number;
  totalCents: number;
  /** All flexible spending in the month: the denominator for `share`. */
  flexibleCents: number;
  /** Small purchases as a share of flexible spending, 0..1. */
  share: number;
  /** Where most of it went, largest first. */
  top: { label: string; cents: number; count: number }[];
}

/**
 * Flexible purchases under $10 in one month. Scheduled bills and recurring charges are left
 * out (a $7 subscription is a commitment, not a habit), as are transfers and excluded rows.
 * Returns null when the month has no flexible spending to compare against.
 */
export function smallPurchases(txns: ShapeTxn[], month: string, bills: ScheduledLike[], detected: ScheduledLike[]): SmallPurchases | null {
  let count = 0;
  let totalCents = 0;
  let flexibleCents = 0;
  const byMerchant = new Map<string, { label: string; cents: number; count: number }>();
  for (const t of txns) {
    if (t.date.slice(0, 7) !== month || !isExpenseTxn(t)) continue;
    if (classifyExpense(t, bills, detected) !== "flexible") continue;
    const cents = -t.amount_cents;
    flexibleCents += cents;
    if (cents >= SMALL_PURCHASE_MAX_CENTS) continue;
    count++;
    totalCents += cents;
    const key = merchantKey(t.description);
    const row = byMerchant.get(key) ?? { label: t.description, cents: 0, count: 0 };
    row.cents += cents;
    row.count++;
    byMerchant.set(key, row);
  }
  if (flexibleCents === 0) return null;
  const top = [...byMerchant.values()].sort((a, b) => b.cents - a.cents).slice(0, 3);
  return { count, totalCents, flexibleCents, share: totalCents / flexibleCents, top };
}
