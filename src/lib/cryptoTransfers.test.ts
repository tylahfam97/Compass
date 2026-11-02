import { describe, it, expect } from "vitest";
import { CRYPTO_CATEGORY_ID, matchCryptoTransfers, planCryptoLinkChanges, toCryptoOutflow } from "./cryptoTransfers";
import type { CryptoOutflow, CryptoTransferLink, PortfolioDeposit } from "./cryptoTransfers";

const out = (id: number, date: string, amountCents: number, profileId = 1, eligible = true): CryptoOutflow => ({ id, profileId, date, amountCents, eligible });
const dep = (id: number, date: string, amountCents: number, profileId = 1): PortfolioDeposit => ({ id, profileId, date, amountCents });

describe("matchCryptoTransfers", () => {
  it("matches only exact-cent amounts within the window, in either date order", () => {
    // Synthetic version of the #107 example: one exact match, one 10-cent near-miss, one unmatched.
    const outflows = [out(1, "2026-03-02", -32573), out(2, "2026-03-05", -21223), out(3, "2026-03-09", -15000)];
    const deposits = [dep(10, "2026-02-28", 32573), dep(11, "2026-03-05", 21233), dep(12, "2026-03-10", 12500)];
    expect(matchCryptoTransfers(outflows, deposits)).toEqual([{ transactionId: 1, activityId: 10 }]);
  });

  it("leaves ambiguous amounts unmatched on both sides", () => {
    expect(matchCryptoTransfers([out(1, "2026-03-02", -10000), out(2, "2026-03-03", -10000)], [dep(10, "2026-03-02", 10000)])).toEqual([]);
    expect(matchCryptoTransfers([out(1, "2026-03-02", -10000)], [dep(10, "2026-03-02", 10000), dep(11, "2026-03-04", 10000)])).toEqual([]);
  });

  it("treats a same-amount Transfers outflow as competing funding, never as a match", () => {
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000), out(2, "2026-03-02", -5000, 1, false)], [dep(10, "2026-03-02", 5000)])).toEqual([]);
    expect(matchCryptoTransfers([out(2, "2026-03-02", -5000, 1, false)], [dep(10, "2026-03-02", 5000)])).toEqual([]);
  });

  it("never matches an unreadable date", () => {
    expect(matchCryptoTransfers([out(1, "03/01/2026", -5000)], [dep(10, "2026-03-01", 5000)])).toEqual([]);
  });

  it("respects the window, the profile and the money direction", () => {
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000)], [dep(10, "2026-03-07", 5000)])).toEqual([]);
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000)], [dep(10, "2026-03-06", 5000)])).toEqual([{ transactionId: 1, activityId: 10 }]);
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000, 1)], [dep(10, "2026-03-01", 5000, 2)])).toEqual([]);
    expect(matchCryptoTransfers([out(1, "2026-03-01", 5000)], [dep(10, "2026-03-01", 5000)])).toEqual([]);
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000)], [dep(10, "2026-03-01", -5000)])).toEqual([]);
  });

  it("counts calendar days across month and year ends", () => {
    expect(matchCryptoTransfers([out(1, "2025-12-30", -700)], [dep(10, "2026-01-04", 700)])).toEqual([{ transactionId: 1, activityId: 10 }]);
  });
});

const TRANSFERS = 20;
const SHOPPING = 4;

/**
 * In-memory model of db.ts reconcileCryptoTransfers (same steps, same pure helpers), so staged
 * imports and category edits can be replayed without SQLite. Rows are bank/card outflows; only
 * Crypto/Transfers rows are visible to matching, as in the SQL.
 */
interface Row { id: number; hash: string; date: string; amountCents: number; categoryId: number; profileId?: number }
interface World { rows: Row[]; deposits: PortfolioDeposit[]; links: CryptoTransferLink[]; rejected: Set<string> }
const world = (): World => ({ rows: [], deposits: [], links: [], rejected: new Set() });
function reconcile(w: World): number {
  const byId = new Map(w.rows.map((r) => [r.id, r]));
  for (const l of w.links) {
    const r = byId.get(l.transactionId);
    if (r && r.categoryId !== TRANSFERS) w.rejected.add(r.hash);
  }
  w.links = w.links.filter((l) => byId.get(l.transactionId)?.categoryId === TRANSFERS);
  const outflows = w.rows
    .filter((r) => (r.categoryId === CRYPTO_CATEGORY_ID || r.categoryId === TRANSFERS) && r.amountCents < 0)
    .map((r) => toCryptoOutflow({
      id: r.id, profileId: r.profileId ?? 1, date: r.date, amountCents: r.amountCents, categoryId: r.categoryId,
      linked: w.links.some((l) => l.transactionId === r.id), rejected: w.rejected.has(r.hash),
    }));
  const { revoke, add } = planCryptoLinkChanges(w.links, matchCryptoTransfers(outflows, w.deposits));
  for (const l of revoke) {
    const r = byId.get(l.transactionId)!;
    if (r.categoryId === TRANSFERS) r.categoryId = l.previousCategoryId ?? CRYPTO_CATEGORY_ID;
    w.links = w.links.filter((x) => x.transactionId !== l.transactionId);
  }
  for (const m of add) {
    w.links.push({ ...m, previousCategoryId: CRYPTO_CATEGORY_ID });
    const r = byId.get(m.transactionId)!;
    if (r.categoryId === CRYPTO_CATEGORY_ID) r.categoryId = TRANSFERS;
  }
  return add.length;
}
const cat = (w: World, id: number) => w.rows.find((r) => r.id === id)!.categoryId;
const purchase = (id: number, date: string, amountCents: number, categoryId = CRYPTO_CATEGORY_ID): Row =>
  ({ id, hash: `h${id}`, date, amountCents, categoryId });

describe("planCryptoLinkChanges", () => {
  it("keeps reproduced links, revokes the rest and adds only new pairs", () => {
    const links = [{ transactionId: 1, activityId: 10, previousCategoryId: 25 }, { transactionId: 2, activityId: 11, previousCategoryId: 25 }];
    expect(planCryptoLinkChanges(links, [{ transactionId: 1, activityId: 10 }, { transactionId: 2, activityId: 12 }])).toEqual({
      revoke: [links[1]], add: [{ transactionId: 2, activityId: 12 }],
    });
  });
});

describe("toCryptoOutflow", () => {
  const base = { id: 1, profileId: 1, date: "2026-03-01", amountCents: -100 };
  it("re-checks linked rows as purchases and keeps Transfers/corrected rows as competitors only", () => {
    expect(toCryptoOutflow({ ...base, categoryId: CRYPTO_CATEGORY_ID, linked: 0, rejected: 0 }).eligible).toBe(true);
    expect(toCryptoOutflow({ ...base, categoryId: TRANSFERS, linked: 1, rejected: 0 }).eligible).toBe(true);
    expect(toCryptoOutflow({ ...base, categoryId: TRANSFERS, linked: 0, rejected: 0 }).eligible).toBe(false);
    expect(toCryptoOutflow({ ...base, categoryId: CRYPTO_CATEGORY_ID, linked: 0, rejected: 1 }).eligible).toBe(false);
  });
});

describe("staged reconciliation (#107 audit F1/F2)", () => {
  const matched = () => {
    const w = world();
    w.rows.push(purchase(1, "2026-03-02", -10000));
    w.deposits.push(dep(10, "2026-03-02", 10000));
    expect(reconcile(w)).toBe(1);
    expect(cat(w, 1)).toBe(TRANSFERS);
    return w;
  };

  it("revokes a match when a later competing Crypto purchase arrives (and is order-independent)", () => {
    const w = matched();
    w.rows.push(purchase(2, "2026-03-03", -10000));
    expect(reconcile(w)).toBe(0);
    expect([cat(w, 1), cat(w, 2)]).toEqual([CRYPTO_CATEGORY_ID, CRYPTO_CATEGORY_ID]);
    expect(w.links).toEqual([]);
    expect(w.rows.map((r) => r.amountCents)).toEqual([-10000, -10000]); // amounts untouched
  });

  it("revokes a match when a later competing deposit arrives", () => {
    const w = matched();
    w.deposits.push(dep(11, "2026-03-04", 10000));
    reconcile(w);
    expect(cat(w, 1)).toBe(CRYPTO_CATEGORY_ID);
    expect(w.links).toEqual([]);
  });

  it("revokes a match when a later same-amount Transfers outflow could be the real funding", () => {
    const w = matched();
    w.rows.push(purchase(3, "2026-03-01", -10000, TRANSFERS));
    reconcile(w);
    expect([cat(w, 1), cat(w, 3)]).toEqual([CRYPTO_CATEGORY_ID, TRANSFERS]);
  });

  it("matches again once the competitor is removed or re-categorized to something unrelated", () => {
    const w = matched();
    w.rows.push(purchase(2, "2026-03-03", -10000));
    reconcile(w);
    w.rows.find((r) => r.id === 2)!.categoryId = SHOPPING; // single/bulk/rule edit
    expect(reconcile(w)).toBe(1);
    expect(cat(w, 1)).toBe(TRANSFERS);
  });

  it("matches a row newly categorized Crypto after both imports (single, bulk, rule or manual entry)", () => {
    const w = world();
    w.rows.push(purchase(1, "2026-03-02", -10000, SHOPPING));
    w.deposits.push(dep(10, "2026-03-02", 10000));
    expect(reconcile(w)).toBe(0);
    w.rows[0].categoryId = CRYPTO_CATEGORY_ID;
    expect(reconcile(w)).toBe(1);
    expect(cat(w, 1)).toBe(TRANSFERS);
  });

  it("never re-matches a match the user corrected, even after undo and reimport, but still counts it as competition", () => {
    const w = matched();
    w.rows[0].categoryId = CRYPTO_CATEGORY_ID; // user says: this was spending
    expect(reconcile(w)).toBe(0);
    expect(cat(w, 1)).toBe(CRYPTO_CATEGORY_ID);
    expect(w.rejected.has("h1")).toBe(true);
    // Undo the bank import, then reimport it: new row id, same import hash.
    w.rows = [{ ...purchase(5, "2026-03-02", -10000), hash: "h1" }];
    expect(reconcile(w)).toBe(0);
    expect(cat(w, 5)).toBe(CRYPTO_CATEGORY_ID);
    // A different purchase of the same amount stays ambiguous against the corrected row.
    w.rows.push(purchase(6, "2026-03-03", -10000));
    expect(reconcile(w)).toBe(0);
  });

  it("reverts a match when its deposit import is undone, without treating it as a correction", () => {
    const w = matched();
    w.deposits = [];
    reconcile(w);
    expect(cat(w, 1)).toBe(CRYPTO_CATEGORY_ID);
    expect(w.rejected.size).toBe(0);
    w.deposits.push(dep(12, "2026-03-02", 10000)); // reimported deposit, new id
    expect(reconcile(w)).toBe(1);
  });

  it("is idempotent", () => {
    const w = matched();
    expect(reconcile(w)).toBe(0);
    expect(w.links).toEqual([{ transactionId: 1, activityId: 10, previousCategoryId: CRYPTO_CATEGORY_ID }]);
  });
});
