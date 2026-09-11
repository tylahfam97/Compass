import { getDb } from "./db";
import { buildSoundingHistory, monthCutoffs, type BalanceObservation, type SoundingPoint } from "./soundings";

/**
 * Overview's data: the roster of every account in scope (bank, card, loan and investment,
 * across every visible profile) and each profile's standing, derived from that one roster
 * rather than a second pass over the database.
 *
 * The inclusion rules mirror `computeNetWorth` exactly, so the roster's totals and the
 * Soundings figure can never disagree: bank, card and loan accounts hidden from the
 * dashboard are excluded, and holdings are always counted.
 */

export type OverviewAccountKind = "checking" | "credit" | "loan" | "investment";

export interface OverviewAccount {
  id: number;
  profileId: number;
  name: string;
  kind: OverviewAccountKind;
  /** Latest recorded balance, or the latest holdings total for an investment account. */
  balanceCents: number | null;
  balanceDate: string | null;
  /** Hidden from the dashboard, so it is listed but not counted. Never set for investments. */
  hidden: boolean;
  series: { date: string; balance_cents: number }[];
}

export interface ProfileStanding {
  profileId: number;
  liquidCents: number;
  investmentCents: number;
  /** Cards and loans combined, <= 0. */
  owedCents: number;
  netWorthCents: number;
  accountCount: number;
}

/** Days of balance history kept for the roster's sparklines. */
const SERIES_DAYS = 180;

const KIND_ORDER: Record<OverviewAccountKind, number> = { checking: 0, investment: 1, credit: 2, loan: 3 };

export async function getOverviewAccounts(profileIds: number[]): Promise<OverviewAccount[]> {
  if (profileIds.length === 0) return [];
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");

  const [accountRows, balanceRows, seriesRows, holdingRows] = await Promise.all([
    db.select<{ id: number; profile_id: number; name: string; account_type: OverviewAccountKind; hidden_from_dashboard: number }[]>(
      `SELECT a.id, a.profile_id, a.name, a.account_type, a.hidden_from_dashboard FROM accounts a
       WHERE a.profile_id IN (${ph}) AND a.account_type IN ('checking','credit','loan','investment')
       ORDER BY a.name`,
      [...profileIds]
    ),
    db.select<{ account_id: number; balance_cents: number | null; balance_date: string | null }[]>(
      `SELECT a.id as account_id,
         (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
          ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents,
         (SELECT t.date FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
          ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_date
       FROM accounts a WHERE a.profile_id IN (${ph}) AND a.account_type IN ('checking','credit','loan')`,
      [...profileIds]
    ),
    db.select<{ account_id: number; date: string; balance_cents: number }[]>(
      `SELECT t.account_id, t.date, t.balance_cents FROM transactions t
       JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id IN (${ph}) AND t.balance_cents IS NOT NULL
         AND a.account_type IN ('checking','credit','loan')
         AND t.date >= date('now','-${SERIES_DAYS} days')
       ORDER BY t.date ASC, t.id ASC`,
      [...profileIds]
    ),
    // One total per account per statement date, so an investment account gets the same
    // "latest value plus a trend" treatment as a bank account.
    db.select<{ account_id: number; date: string; balance_cents: number }[]>(
      `SELECT h.account_id, h.as_of_date as date, SUM(h.market_value_cents) as balance_cents
       FROM holdings h WHERE h.profile_id IN (${ph})
       GROUP BY h.account_id, h.as_of_date ORDER BY h.as_of_date ASC`,
      [...profileIds]
    ),
  ]);

  const balanceById = new Map(balanceRows.map((r) => [r.account_id, r]));
  const seriesById = new Map<number, { date: string; balance_cents: number }[]>();
  for (const source of [seriesRows, holdingRows]) {
    for (const r of source) {
      const list = seriesById.get(r.account_id);
      // One point per date: a later row for the same day supersedes the earlier one.
      if (list && list[list.length - 1]?.date === r.date) list[list.length - 1] = { date: r.date, balance_cents: r.balance_cents };
      else if (list) list.push({ date: r.date, balance_cents: r.balance_cents });
      else seriesById.set(r.account_id, [{ date: r.date, balance_cents: r.balance_cents }]);
    }
  }

  const accounts = accountRows.map((a) => {
    const series = seriesById.get(a.id) ?? [];
    const recorded = balanceById.get(a.id);
    const isInvestment = a.account_type === "investment";
    const lastPoint = series.length > 0 ? series[series.length - 1] : null;
    return {
      id: a.id,
      profileId: a.profile_id,
      name: a.name,
      kind: a.account_type,
      balanceCents: isInvestment ? lastPoint?.balance_cents ?? null : recorded?.balance_cents ?? null,
      balanceDate: isInvestment ? lastPoint?.date ?? null : recorded?.balance_date ?? null,
      hidden: !isInvestment && !!a.hidden_from_dashboard,
      series,
    } satisfies OverviewAccount;
  });

  return accounts.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

/**
 * Month-by-month net worth for the Soundings instrument.
 *
 * Two queries feed a single pass over the result, rather than recomputing a whole net-worth
 * snapshot per month: at 24 months that difference is 2 queries instead of 48, which is what
 * keeps Overview from sitting in its loading state long enough to be noticed.
 */
export async function getSoundingHistory(profileIds: number[], months: number, todayIso: string): Promise<SoundingPoint[]> {
  if (profileIds.length === 0) return [];
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");

  const [balanceRows, holdingRows] = await Promise.all([
    db.select<{ account_id: number; date: string; balance_cents: number; account_type: "checking" | "credit" | "loan" }[]>(
      `SELECT t.account_id, t.date, t.balance_cents, a.account_type FROM transactions t
       JOIN accounts a ON a.id=t.account_id
       WHERE t.profile_id IN (${ph}) AND t.balance_cents IS NOT NULL
         AND a.account_type IN ('checking','credit','loan') AND a.hidden_from_dashboard=0
       ORDER BY t.date ASC, t.id ASC`,
      [...profileIds]
    ),
    db.select<{ account_id: number; date: string; balance_cents: number }[]>(
      `SELECT h.account_id, h.as_of_date as date, SUM(h.market_value_cents) as balance_cents
       FROM holdings h WHERE h.profile_id IN (${ph})
       GROUP BY h.account_id, h.as_of_date ORDER BY h.as_of_date ASC`,
      [...profileIds]
    ),
  ]);

  const observations: BalanceObservation[] = [
    ...balanceRows.map((r) => ({ accountId: r.account_id, date: r.date, valueCents: r.balance_cents, kind: r.account_type })),
    // Investment account ids never collide with the bank/card/loan ids above: they are rows
    // in the same accounts table.
    ...holdingRows.map((r) => ({ accountId: r.account_id, date: r.date, valueCents: r.balance_cents, kind: "investment" as const })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // A statement can be dated ahead of today. `computeNetWorth` and the account roster both
  // count it, so the newest sounding stretches to cover it too; otherwise the headline figure
  // and the roster sitting under it would disagree by that statement's amount.
  const cutoffs = monthCutoffs(todayIso, months);
  const newest = observations.length > 0 ? observations[observations.length - 1].date : todayIso;
  const last = cutoffs[cutoffs.length - 1];
  if (last && newest > last.cutoff) cutoffs[cutoffs.length - 1] = { ...last, cutoff: newest };

  return buildSoundingHistory(observations, cutoffs);
}

/**
 * Each profile's standing from the shared roster. Hidden bank, card and loan accounts are
 * left out and investments are always counted, matching `computeNetWorth`.
 */
export function standingsByProfile(accounts: OverviewAccount[], profileIds: number[]): Map<number, ProfileStanding> {
  const out = new Map<number, ProfileStanding>();
  for (const id of profileIds) {
    out.set(id, { profileId: id, liquidCents: 0, investmentCents: 0, owedCents: 0, netWorthCents: 0, accountCount: 0 });
  }
  for (const a of accounts) {
    const s = out.get(a.profileId);
    if (!s) continue;
    s.accountCount += 1;
    if (a.hidden || a.balanceCents === null) continue;
    if (a.kind === "checking") s.liquidCents += a.balanceCents;
    else if (a.kind === "investment") s.investmentCents += a.balanceCents;
    else s.owedCents += a.balanceCents;
  }
  for (const s of out.values()) s.netWorthCents = s.liquidCents + s.investmentCents + s.owedCents;
  return out;
}
