// ─── Crypto purchases that are really transfers into a tracked portfolio (#107) ──────────────
// A bank/card outflow categorized Crypto is spending by default. When the same money also
// arrives as a deposit in an investment account Compass tracks, counting it as spending double
// counts it: once as an expense and again as an investment holding. Only an unambiguous,
// exact-cent match within a few days is treated as a transfer; everything else stays exactly as
// it was. Nothing is created, deleted, or re-amounted - only the matched outflow's category moves.

/** System category ids (see db.ts v7 seed). */
export const CRYPTO_CATEGORY_ID = 25;

/** Exchange deposits usually post the same day; bank settlement can lag a few days either way. */
export const CRYPTO_MATCH_WINDOW_DAYS = 5;

export interface CryptoOutflow {
  id: number;
  profileId: number;
  /** Local YYYY-MM-DD. */
  date: string;
  /** Negative: money leaving the bank/card account. */
  amountCents: number;
  /** False for an outflow that may only compete for a deposit, never be matched to it (an
   *  outflow already categorized Transfers can be the deposit's real funding). */
  eligible: boolean;
}

export interface PortfolioDeposit {
  id: number;
  profileId: number;
  /** Local YYYY-MM-DD. */
  date: string;
  /** Positive: money arriving in the investment account. */
  amountCents: number;
}

export interface CryptoTransferMatch {
  transactionId: number;
  activityId: number;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * Pairs each outflow with a deposit of exactly the same amount (in cents) for the same profile
 * within `windowDays`. A pair is accepted only when it is the outflow's ONLY candidate and the
 * deposit's ONLY candidate - two $100 purchases near one $100 deposit (or the reverse) are
 * ambiguous and neither side is matched. Ineligible outflows (already Transfers) count toward
 * that ambiguity but are never matched themselves. Near-misses (fees, spreads, a typo) never match.
 */
export function matchCryptoTransfers(
  outflows: CryptoOutflow[],
  deposits: PortfolioDeposit[],
  windowDays = CRYPTO_MATCH_WINDOW_DAYS,
): CryptoTransferMatch[] {
  const candidates: [CryptoOutflow, PortfolioDeposit][] = [];
  for (const o of outflows) {
    if (o.amountCents >= 0) continue;
    for (const d of deposits) {
      if (d.amountCents <= 0 || d.profileId !== o.profileId || d.amountCents !== -o.amountCents) continue;
      // Written so an unparseable date (NaN) fails the window instead of passing it.
      if (!(Math.abs(dayNumber(d.date) - dayNumber(o.date)) <= windowDays)) continue;
      candidates.push([o, d]);
    }
  }
  const count = (key: (p: [CryptoOutflow, PortfolioDeposit]) => number) => {
    const m = new Map<number, number>();
    for (const p of candidates) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
    return m;
  };
  const perOutflow = count(([o]) => o.id);
  const perDeposit = count(([, d]) => d.id);
  return candidates
    .filter(([o, d]) => o.eligible && perOutflow.get(o.id) === 1 && perDeposit.get(d.id) === 1)
    .map(([o, d]) => ({ transactionId: o.id, activityId: d.id }));
}
